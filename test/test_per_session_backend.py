"""Per-session ACP backend pick: ``POST /api/chat/slots`` ``acp_backend``.

A dashboard slot may name the harness it runs on instead of following the
global ``agent.acp_backend``. The pick is fixed at creation, carried on the
slot, persisted with its metadata, and reaches the provider factory as the
optional ``acp_backend`` kwarg -- where it is an INPUT to the one selection
gate (``members.select_provider_backend``, H3/H13), never a second gate. These
tests pin the four seams that carry it and the two behaviours that must not
change: a slot with no pick, and a pick this build cannot serve.
"""

from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from chat_test_helpers import _make_ready_kiro_prerequisite

from kiro_crew.acp_backends import ACP_BACKEND_CLAUDE, ACP_BACKEND_CODEX, ACP_BACKEND_KIRO
from kiro_crew.config.loader import KiroCrewConfig
from kiro_crew.dashboard.chat_persistence import _restore_slot_acp_backend
from kiro_crew.dashboard.state import DashboardState, _ChatSlot
from kiro_crew.history import ConversationLog

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _make_state(tmp_path):
    sessions = MagicMock(count=0)
    sessions.remove = AsyncMock()
    sessions.recycle_background = AsyncMock()
    sessions.get_pid = MagicMock(return_value=None)
    state = DashboardState(
        sessions=sessions,
        crons=MagicMock(list_jobs=MagicMock(return_value=[]), status=MagicMock(return_value={})),
        lessons=MagicMock(load_all=MagicMock(return_value=[])),
        start_time=0.0,
        conversation_log=ConversationLog(base_dir=tmp_path),
    )
    state.kiro_prerequisite_service = _make_ready_kiro_prerequisite()
    return state


def _make_app(state) -> web.Application:
    from kiro_crew.dashboard.chat import api_chat_slot_create, api_chat_slots

    app = web.Application()
    app["state"] = state
    app.router.add_post("/api/chat/slots", api_chat_slot_create)
    app.router.add_get("/api/chat/slots", api_chat_slots)
    return app


class TestCreateEndpoint:
    @pytest.mark.asyncio
    async def test_pick_is_stored_and_echoed(self, tmp_path):
        state = _make_state(tmp_path)
        async with TestClient(TestServer(_make_app(state))) as client:
            resp = await client.post(
                "/api/chat/slots", json={"name": "s1", "acp_backend": ACP_BACKEND_CODEX}
            )
            assert resp.status == 200
            assert (await resp.json())["acp_backend"] == ACP_BACKEND_CODEX
            assert state._slots["s1"].acp_backend == ACP_BACKEND_CODEX

            listed = await (await client.get("/api/chat/slots")).json()
            rows = listed["slots"] if isinstance(listed, dict) else listed
            row = next(s for s in rows if s["key"] == "s1")
            assert row["acp_backend"] == ACP_BACKEND_CODEX

            # The detail endpoint is a transcript window and carries no slot
            # fields (not even ``model``), so it is deliberately not asserted.

    @pytest.mark.asyncio
    async def test_kiro_is_a_real_pick(self, tmp_path):
        """ "" round-trips as itself: it is the Kiro CLI id, not "unset"."""
        state = _make_state(tmp_path)
        async with TestClient(TestServer(_make_app(state))) as client:
            resp = await client.post(
                "/api/chat/slots", json={"name": "s1", "acp_backend": ACP_BACKEND_KIRO}
            )
            assert resp.status == 200
            assert (await resp.json())["acp_backend"] == ACP_BACKEND_KIRO
            assert state._slots["s1"].acp_backend == ACP_BACKEND_KIRO

    @pytest.mark.asyncio
    async def test_no_pick_is_none(self, tmp_path):
        """The pre-picker shape: absent field, slot follows the global."""
        state = _make_state(tmp_path)
        async with TestClient(TestServer(_make_app(state))) as client:
            resp = await client.post("/api/chat/slots", json={"name": "s1"})
            assert resp.status == 200
            assert (await resp.json())["acp_backend"] is None
            assert state._slots["s1"].acp_backend is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["no-such-backend", "Codex", 7, ["codex"]])
    async def test_value_outside_the_live_selectable_list_is_400(self, tmp_path, bad):
        state = _make_state(tmp_path)
        async with TestClient(TestServer(_make_app(state))) as client:
            resp = await client.post("/api/chat/slots", json={"name": "s1", "acp_backend": bad})
            assert resp.status == 400
            assert (await resp.json())["code"] == "invalid_acp_backend"
            assert "s1" not in state._slots


class TestFactoryThreading:
    """The pick must reach the provider through the REAL factory and gate."""

    def test_explicit_pick_reaches_the_provider(self):
        cfg = KiroCrewConfig()
        assert cfg.agent.acp_backend == ACP_BACKEND_KIRO
        provider = cfg.create_provider_factory()(
            session_key="dashboard:test", agent="", acp_backend=ACP_BACKEND_CODEX
        )
        assert provider.client.backend == ACP_BACKEND_CODEX

    def test_explicit_pick_beats_the_configured_backend(self):
        cfg = KiroCrewConfig()
        cfg.agent.acp_backend = ACP_BACKEND_CLAUDE
        provider = cfg.create_provider_factory()(
            session_key="dashboard:test", agent="", acp_backend=ACP_BACKEND_KIRO
        )
        assert provider.is_kiro_backend is True

    def test_no_pick_follows_the_configured_backend(self):
        cfg = KiroCrewConfig()
        cfg.agent.acp_backend = ACP_BACKEND_CLAUDE
        provider = cfg.create_provider_factory()(session_key="dashboard:test", agent="")
        assert provider.client.backend == ACP_BACKEND_CLAUDE

    def test_unservable_pick_degrades_to_kiro_not_an_error(self):
        """H3 at the per-session arm: a persisted pick this build stopped
        serving must spawn on the floor, not fail the session."""
        cfg = KiroCrewConfig()
        provider = cfg.create_provider_factory()(
            session_key="dashboard:test", agent="", acp_backend="no-such-backend"
        )
        assert provider.is_kiro_backend is True

    def test_chat_runner_hands_the_slot_pick_to_every_spawn(self):
        """Both ``get_or_create`` call sites carry the slot's pick, so an eager
        spawn and the real first turn cannot disagree on the harness."""
        src = (_REPO_ROOT / "src/kiro_crew/dashboard/chat_runner.py").read_text(encoding="utf-8")
        sites = re.findall(r"sessions\.get_or_create\((?:.|\n)*?\)\n", src)
        carrying = [s for s in sites if "acp_backend=slot.acp_backend" in s]
        assert len(carrying) == 2, [s[:80] for s in sites]


class TestPersistence:
    def test_restore_reads_a_string_pick(self):
        slot = _ChatSlot("s1")
        _restore_slot_acp_backend(slot, {"acp_backend": ACP_BACKEND_CODEX})
        assert slot.acp_backend == ACP_BACKEND_CODEX

    def test_restore_reads_the_kiro_pick(self):
        slot = _ChatSlot("s1")
        _restore_slot_acp_backend(slot, {"acp_backend": ACP_BACKEND_KIRO})
        assert slot.acp_backend == ACP_BACKEND_KIRO

    @pytest.mark.parametrize("meta", [{}, {"acp_backend": None}, {"acp_backend": 3}])
    def test_restore_without_a_pick_keeps_none(self, meta):
        """A pre-picker transcript, and a hand-edited one, both follow the global."""
        slot = _ChatSlot("s1")
        _restore_slot_acp_backend(slot, meta)
        assert slot.acp_backend is None

    def test_restore_does_not_re_derive_selectability(self):
        """Selectability is decided by the ONE gate at spawn (H4); restore keeps
        the pick so a later gateway that serves it again can honour it."""
        slot = _ChatSlot("s1")
        _restore_slot_acp_backend(slot, {"acp_backend": "not-served-here"})
        assert slot.acp_backend == "not-served-here"

    def test_fork_inherits_the_parent_pick(self):
        src = (_REPO_ROOT / "src/kiro_crew/dashboard/chat_fork.py").read_text(encoding="utf-8")
        assert "new_slot.acp_backend = slot.acp_backend" in src


# ── POST /api/chat/slots/{slot}/backend ──────────────────────────────────────


def _switch_state(slot: _ChatSlot) -> DashboardState:
    """The switch handlers' state double (the workspace tests' shape)."""
    state = MagicMock(spec=DashboardState)
    state._slots = {slot.key: slot}
    state.push_slots_update = MagicMock()
    state.sessions = MagicMock()
    state.sessions.get_provider = MagicMock(return_value=None)
    return state


class TestSwitchEndpoint:
    """The slot's pick can change; a live session is reset so the next turn
    spawns on the new harness with the transcript re-injected."""

    async def _post(self, state, name, payload):
        from kiro_crew.dashboard.chat import api_chat_slot_backend

        app = web.Application()
        app["state"] = state
        app.router.add_post("/api/chat/slots/{slot}/backend", api_chat_slot_backend)
        async with TestClient(TestServer(app)) as client:
            resp = await client.post(f"/api/chat/slots/{name}/backend", json=payload)
            return resp.status, await resp.json()

    @pytest.mark.asyncio
    async def test_switch_on_an_idle_slot_persists_and_resets_the_session(self):
        from kiro_crew.dashboard import chat_handlers as ch

        slot = _ChatSlot("s1")
        slot.model = "some-pin"
        slot._dirty = False
        state = _switch_state(slot)
        with patch(f"{ch.__name__}._reset_slot_session", new=AsyncMock(return_value=True)) as rs:
            status, body = await self._post(state, "s1", {"acp_backend": ACP_BACKEND_CODEX})
        assert (status, body) == (200, {"ok": True, "acp_backend": ACP_BACKEND_CODEX, "model": ""})
        assert slot.acp_backend == ACP_BACKEND_CODEX
        # The model pin belonged to the old harness's namespace; it is cleared
        # with the session rather than carried onto a backend that refuses it.
        assert slot.model == ""
        assert slot._dirty is True
        rs.assert_awaited_once()
        state.push_slots_update.assert_called_once()

    @pytest.mark.asyncio
    async def test_null_clears_the_pick(self):
        from kiro_crew.dashboard import chat_handlers as ch

        slot = _ChatSlot("s1")
        slot.acp_backend = ACP_BACKEND_CODEX
        state = _switch_state(slot)
        with patch(f"{ch.__name__}._reset_slot_session", new=AsyncMock(return_value=True)):
            status, body = await self._post(state, "s1", {"acp_backend": None})
        assert status == 200
        assert body["acp_backend"] is None
        assert slot.acp_backend is None

    @pytest.mark.asyncio
    async def test_same_pick_is_a_no_op(self):
        from kiro_crew.dashboard import chat_handlers as ch

        slot = _ChatSlot("s1")
        slot.acp_backend = ACP_BACKEND_CLAUDE
        slot.model = "keep-me"
        state = _switch_state(slot)
        with patch(f"{ch.__name__}._reset_slot_session", new=AsyncMock()) as rs:
            status, body = await self._post(state, "s1", {"acp_backend": ACP_BACKEND_CLAUDE})
        assert (status, body["ok"]) == (200, True)
        rs.assert_not_awaited()
        assert slot.model == "keep-me"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["no-such-backend", "Codex", 7, ["codex"]])
    async def test_value_outside_the_live_selectable_list_is_400(self, bad):
        slot = _ChatSlot("s1")
        status, body = await self._post(_switch_state(slot), "s1", {"acp_backend": bad})
        assert status == 400
        assert body["code"] == "invalid_acp_backend"
        assert slot.acp_backend is None

    @pytest.mark.asyncio
    async def test_missing_field_is_400(self):
        status, body = await self._post(_switch_state(_ChatSlot("s1")), "s1", {})
        assert (status, body["code"]) == (400, "invalid_acp_backend")

    @pytest.mark.asyncio
    async def test_running_turn_is_409_and_changes_nothing(self):
        from kiro_crew.dashboard import chat_handlers as ch

        slot = _ChatSlot("s1")
        slot.model = "pin"
        # ``running`` reads the task: a not-done task is an in-flight turn.
        slot.task = MagicMock(done=MagicMock(return_value=False))
        state = _switch_state(slot)
        with patch(f"{ch.__name__}._reset_slot_session", new=AsyncMock()) as rs:
            status, body = await self._post(state, "s1", {"acp_backend": ACP_BACKEND_CODEX})
        assert (status, body["code"]) == (409, "turn_in_flight")
        assert slot.acp_backend is None
        assert slot.model == "pin"
        rs.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_declined_reset_under_a_turn_rolls_back(self):
        from kiro_crew.dashboard import chat_handlers as ch
        from kiro_crew.providers.base import LLMProvider

        slot = _ChatSlot("s1")
        slot.model = "pin"
        state = _switch_state(slot)
        busy = MagicMock(spec=LLMProvider)
        busy.has_active_turn = MagicMock(return_value=False)
        # Idle at the pre-check, busy by the time the reset is declined: the
        # handler re-checks and unwinds its commit instead of leaving a pick
        # nothing runs.
        state.sessions.get_provider = MagicMock(side_effect=[None, busy, busy])
        with patch(f"{ch.__name__}._reset_slot_session", new=AsyncMock(return_value=False)):
            busy.has_active_turn = MagicMock(return_value=True)
            status, body = await self._post(state, "s1", {"acp_backend": ACP_BACKEND_CODEX})
        assert (status, body["code"]) == (409, "turn_in_flight")
        assert slot.acp_backend is None
        assert slot.model == "pin"

    @pytest.mark.asyncio
    async def test_member_thread_is_pinned(self):
        from kiro_crew import members as members_mod

        slot = _ChatSlot("member-alice")
        slot.mode = members_mod.DM_SLOT_MODE
        status, body = await self._post(
            _switch_state(slot), "member-alice", {"acp_backend": ACP_BACKEND_CODEX}
        )
        assert (status, body["code"]) == (409, "member_thread_backend_pinned")
        assert slot.acp_backend is None

    @pytest.mark.asyncio
    async def test_unknown_slot_is_404(self):
        state = _switch_state(_ChatSlot("s1"))
        status, _ = await self._post(state, "missing", {"acp_backend": ACP_BACKEND_CODEX})
        assert status == 404


# ── GET /api/models?backend= ─────────────────────────────────────────────────


class TestModelsBackendParam:
    """The list a slot with a per-session pick offers: that backend's own."""

    async def _get(self, query: str, *, configured: str = ACP_BACKEND_CLAUDE):
        from types import SimpleNamespace

        from kiro_crew.dashboard.handlers.agents import api_models

        state = MagicMock(spec=DashboardState)
        state.sessions = MagicMock()
        state.sessions.active_providers = MagicMock(return_value=[])
        app = web.Application()
        app["state"] = state
        app.router.add_get("/api/models", api_models)
        cfg = SimpleNamespace(agent=SimpleNamespace(acp_backend=configured, model=""))
        with patch.object(KiroCrewConfig, "load", classmethod(lambda cls: cfg)):
            async with TestClient(TestServer(app)) as client:
                resp = await client.get("/api/models" + query)
                return resp.status, await resp.json()

    @pytest.mark.asyncio
    async def test_codex_answers_its_own_list_with_auto_first(self):
        status, rows = await self._get("?backend=" + ACP_BACKEND_CODEX)
        assert status == 200
        assert rows[0]["model_name"] == "auto"
        # No codex session has advertised anything here, so nothing but the
        # sentinel is offered -- never a hardcoded id.
        assert all(r["model_name"] == "auto" for r in rows)

    @pytest.mark.asyncio
    async def test_claude_answers_the_claude_namespace(self):
        status, rows = await self._get(
            "?backend=" + ACP_BACKEND_CLAUDE, configured=ACP_BACKEND_CODEX
        )
        assert status == 200
        assert rows[0]["model_name"] == "auto"
        assert len(rows) > 1  # the claude registry rows, not codex's empty list

    @pytest.mark.asyncio
    async def test_unknown_backend_is_400(self):
        status, body = await self._get("?backend=no-such-backend")
        assert (status, body["code"]) == (400, "invalid_acp_backend")

    @pytest.mark.asyncio
    async def test_no_param_keeps_the_configured_backend(self):
        status, rows = await self._get("", configured=ACP_BACKEND_CODEX)
        assert status == 200
        assert all(r["model_name"] == "auto" for r in rows)


# ── Restart: the pin survives on the slot's own harness ──────────────────────


class TestPinSurvivesRestart:
    """A persisted model pin is restored VERBATIM, whatever the global backend.

    Restore never validates a pin against a harness namespace: the transcript's
    ``model`` is the user's choice, ``canonicalize_for_provider`` rewrites only
    the ``claude_code`` provider spelling (``agent.provider`` is always ``acp``),
    and the spawn-time verdict (``_pinned_model_verdict``) is reported, never
    acted on. So a codex-picked slot pinned to a codex id comes back pinned to
    it on a claude-default gateway, and a pin no harness serves comes back too
    (the send path withholds it; restore does not judge it).
    """

    def _persist_and_restore(self, tmp_path, monkeypatch, *, model: str, backend):
        from types import SimpleNamespace

        from kiro_crew.dashboard.chat_persistence import (
            _save_slot_to_history,
            restore_recent_sessions,
        )

        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        # The GLOBAL backend is claude while the slot's own is codex: the
        # namespace the pin must NOT be validated against.
        configured = SimpleNamespace(
            agent=SimpleNamespace(acp_backend=ACP_BACKEND_CLAUDE, provider="acp", model=""),
            agents={},
        )
        monkeypatch.setattr(KiroCrewConfig, "load", classmethod(lambda cls: configured))
        state = _make_state(tmp_path)
        slot = state.get_or_create_slot("s1", acp_backend=backend)
        slot.model = model
        slot.reasoning_effort = "high"
        slot.append("user", "hello")
        slot.drain()
        _save_slot_to_history(state, slot, closed=False)
        del state._slots["s1"]
        assert restore_recent_sessions(state, window_minutes=0) >= 1
        return state._slots["s1"]

    def test_a_codex_pin_survives_a_restart_on_a_claude_default_gateway(
        self, tmp_path, monkeypatch
    ):
        from kiro_crew import model_registry

        # Seed the codex namespace the way a codex session/new would have.
        monkeypatch.setattr(model_registry, "_ADVERTISED_MODELS", {})
        monkeypatch.setattr(model_registry, "persist_advertised_models", lambda: None)
        model_registry.refresh_advertised_models("codex", ["gpt-6-astra", "gpt-5.6-sol"])

        restored = self._persist_and_restore(
            tmp_path, monkeypatch, model="gpt-5.6-sol", backend=ACP_BACKEND_CODEX
        )
        assert restored.acp_backend == ACP_BACKEND_CODEX
        assert restored.model == "gpt-5.6-sol"
        assert restored.reasoning_effort == "high"

    def test_a_pin_in_no_namespace_is_restored_verbatim_not_healed(self, tmp_path, monkeypatch):
        """Control: restore is not where a stale pin is judged. The send path
        withholds it (``_pinned_model_verdict``) and keeps it for re-upgrade."""
        from kiro_crew import model_registry

        monkeypatch.setattr(model_registry, "_ADVERTISED_MODELS", {})
        monkeypatch.setattr(model_registry, "persist_advertised_models", lambda: None)

        restored = self._persist_and_restore(
            tmp_path, monkeypatch, model="no-such-model-anywhere", backend=ACP_BACKEND_CODEX
        )
        assert restored.model == "no-such-model-anywhere"
        assert restored.acp_backend == ACP_BACKEND_CODEX


# ── The model is translated into the SESSION's namespace ─────────────────────


class TestNamespaceTranslation:
    """``acp_effective_model`` keys its namespace on the backend the session
    runs on, which a per-session pick can make differ from the global."""

    PINNED = "opus-4.8-1m"  # a canonical key whose kiro and claude ids differ

    def _cfg(self, global_backend: str):
        from kiro_crew.config.loader import AgentConfig

        return KiroCrewConfig(agent=AgentConfig(acp_backend=global_backend, model=""))

    def test_a_codex_pick_under_a_claude_global_stays_in_the_codex_namespace(self):
        cfg = self._cfg(ACP_BACKEND_CLAUDE)
        resolved = cfg.acp_effective_model(None, "gpt-5.6-sol", acp_backend=ACP_BACKEND_CODEX)
        assert resolved == "gpt-5.6-sol"
        assert "anthropic" not in resolved

    def test_a_claude_pick_under_a_codex_global_lands_in_the_claude_namespace(self):
        cfg = self._cfg(ACP_BACKEND_CODEX)
        resolved = cfg.acp_effective_model(None, self.PINNED, acp_backend=ACP_BACKEND_CLAUDE)
        assert "anthropic" in resolved, resolved

    def test_no_pick_resolves_exactly_as_before(self):
        cfg = self._cfg(ACP_BACKEND_CLAUDE)
        assert cfg.acp_effective_model(None, self.PINNED) == cfg.acp_effective_model(
            None, self.PINNED, acp_backend=ACP_BACKEND_CLAUDE
        )
        kiro = self._cfg(ACP_BACKEND_KIRO)
        assert kiro.acp_effective_model(None, self.PINNED) == "claude-opus-4.8"

    def test_the_factory_hands_the_selected_backend_to_the_resolver(self):
        """The kwarg reaches the resolver from ``_acp`` with the gate's answer:
        the provider is built on the picked backend AND with the model spelled in
        that backend's namespace (the real factory and provider, no spawn)."""
        cfg = self._cfg(ACP_BACKEND_CLAUDE)
        provider = cfg.create_provider_factory()(
            "dashboard:s1", model_override="gpt-5.6-sol", acp_backend=ACP_BACKEND_CODEX
        )
        assert provider._client.backend == ACP_BACKEND_CODEX
        assert provider._client._model == "gpt-5.6-sol"

        reverse = self._cfg(ACP_BACKEND_CODEX).create_provider_factory()(
            "dashboard:s2", model_override=self.PINNED, acp_backend=ACP_BACKEND_CLAUDE
        )
        assert reverse._client.backend == ACP_BACKEND_CLAUDE
        assert "anthropic" in reverse._client._model
