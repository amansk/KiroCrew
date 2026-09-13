"""Model and effort are two choices, on every harness.

codex-acp advertises one ``<base>[<effort>]`` composite per (model, effort)
pair in its ``models`` envelope while its ``model`` config option names the
base alone and ``reasoning_effort`` the level. These pins keep the two apart:
the picker lists bases, the effort dropdown lists levels, a window suffix
(``[1m]``) is never read as a level, and a pick of model + effort reaches the
adapter as the base over ``model`` plus the level over that harness's own
effort option -- never as a composed id.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from kiro_crew import model_registry
from kiro_crew.acp.client import AcpClient
from kiro_crew.acp_backends import (
    ACP_BACKEND_CLAUDE,
    ACP_BACKEND_CODEX,
    ACP_BACKEND_KIRO,
    effort_option_id_for,
)
from kiro_crew.agent_sdk.capabilities import capabilities_for
from kiro_crew.dashboard.handlers import agents
from kiro_crew.effort import collapse_effort_variants, split_effort_model_id

#: The 31 ids a real codex-acp ``models`` envelope advertised (six bases).
CODEX_ENVELOPE_IDS = [
    f"{base}[{lvl}]"
    for base, levels in (
        ("gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"]),
        ("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]),
        ("gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]),
        ("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]),
        ("gpt-5.5", ["low", "medium", "high", "xhigh"]),
        ("gpt-5.3-codex-spark", ["low", "medium", "high", "xhigh"]),
    )
    for lvl in levels
]

#: What codex-acp 0.153 puts on the wire at ``session/new``: BOTH an envelope of
#: composites and a ``model`` select of bases beside a ``reasoning_effort`` select.
CODEX_SESSION_NEW_WITH_ENVELOPE = {
    "sessionId": "codex-sess-2",
    "models": {
        "currentModelId": "gpt-5.6-sol[medium]",
        "availableModels": [{"modelId": i, "name": i} for i in CODEX_ENVELOPE_IDS],
    },
    "configOptions": [
        {
            "id": "model",
            "type": "select",
            "currentValue": "gpt-5.6-sol",
            "options": [
                {"value": b, "name": b}
                for b in (
                    "gpt-6-astra",
                    "gpt-5.6-sol",
                    "gpt-5.6-terra",
                    "gpt-5.6-luna",
                    "gpt-5.5",
                    "gpt-5.3-codex-spark",
                )
            ],
        },
        {
            "id": "reasoning_effort",
            "type": "select",
            "currentValue": "medium",
            "options": [
                {"value": v, "name": v} for v in ("low", "medium", "high", "xhigh", "max", "ultra")
            ],
        },
    ],
}


@pytest.fixture(autouse=True)
def _cold_advertised_cache(monkeypatch):
    monkeypatch.setattr(model_registry, "_ADVERTISED_MODELS", {})
    monkeypatch.setattr(model_registry, "persist_advertised_models", lambda: None)


class TestSplitAndCollapse:
    @pytest.mark.parametrize(
        "model_id,expected",
        [
            ("gpt-6-astra[high]", ("gpt-6-astra", "high")),
            ("gpt-5.3-codex-spark[ultra]", ("gpt-5.3-codex-spark", "ultra")),
            ("opus[1m]", ("opus[1m]", None)),
            ("claude-fable-5-1[1m]", ("claude-fable-5-1[1m]", None)),
            ("gpt-5.5", ("gpt-5.5", None)),
            ("", ("", None)),
        ],
    )
    def test_split_reads_an_effort_suffix_and_never_a_window(self, model_id, expected):
        assert split_effort_model_id(model_id) == expected

    def test_collapse_yields_one_row_per_base_with_its_levels_in_order(self):
        rows = collapse_effort_variants(CODEX_ENVELOPE_IDS)
        assert len(CODEX_ENVELOPE_IDS) == 31
        assert [b for b, _ in rows] == [
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.3-codex-spark",
        ]
        assert dict(rows)["gpt-6-astra"] == ["low", "medium", "high", "xhigh", "max", "ultra"]
        assert dict(rows)["gpt-5.5"] == ["low", "medium", "high", "xhigh"]

    def test_a_bare_id_keeps_no_levels_and_a_window_id_is_untouched(self):
        rows = collapse_effort_variants(["gpt-5.5", "opus[1m]", "default", "opus[1m]"])
        assert rows == [("gpt-5.5", []), ("opus[1m]", []), ("default", [])]


def _request(*providers) -> MagicMock:
    state = SimpleNamespace(sessions=SimpleNamespace(active_providers=lambda: list(providers)))
    request = MagicMock()
    request.app = {"state": state}
    return request


def _codex_client(tmp_path) -> AcpClient:
    client = AcpClient(work_dir=tmp_path, acp_backend=ACP_BACKEND_CODEX)
    client._session_id = "codex-sess-2"
    return client


def _provider_for(client: AcpClient, backend: str) -> MagicMock:
    provider = MagicMock()
    provider.capabilities = capabilities_for(backend)
    provider.available_models = MagicMock(return_value=client.available_models())
    provider.get_valid_effort_levels = MagicMock(return_value=client.get_valid_effort_levels())
    return provider


class TestCodexPickerShape:
    def test_a_live_session_lists_base_models_and_its_effort_select(self, tmp_path):
        client = _codex_client(tmp_path)
        client._capture_available_models(CODEX_SESSION_NEW_WITH_ENVELOPE)
        client._store_session_config(CODEX_SESSION_NEW_WITH_ENVELOPE)

        # The select wins over the envelope: these are the ids
        # ``set_config_option("model")`` accepts back.
        assert [m["modelId"] for m in client.available_models()] == [
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.3-codex-spark",
        ]
        # ...while the served id stays the envelope's truthful composite.
        assert client._resolved_model_id == "gpt-5.6-sol[medium]"
        assert client.get_valid_effort_levels() == [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
        ]

        rows = agents._codex_models(_request(_provider_for(client, ACP_BACKEND_CODEX)))
        assert [r["model_name"] for r in rows] == [
            "auto",
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.3-codex-spark",
        ]
        assert rows[1]["effort_levels"] == ["low", "medium", "high", "xhigh", "max", "ultra"]

    def test_a_cached_envelope_of_composites_collapses_to_bases_with_levels(self):
        """The cross-session cache written by an older capture holds the 31
        composites; the picker still offers six bases, each with its levels."""
        model_registry.refresh_advertised_models("codex", CODEX_ENVELOPE_IDS)

        rows = agents._codex_models(_request())

        assert len(rows) == 7
        assert [r["model_name"] for r in rows][1:] == [
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.3-codex-spark",
        ]
        assert rows[1]["effort_levels"] == ["low", "medium", "high", "xhigh", "max", "ultra"]
        assert rows[5]["effort_levels"] == ["low", "medium", "high", "xhigh"]
        # The adapter's vocabulary now validates on the slot endpoint.
        from kiro_crew.dashboard.chat_persistence import get_reasoning_effort_values

        assert "ultra" in get_reasoning_effort_values()

    def test_a_bare_cached_id_keeps_no_levels(self):
        model_registry.refresh_advertised_models("codex", ["gpt-5.5"])
        rows = agents._codex_models(_request())
        assert [(r["model_name"], r["effort_levels"]) for r in rows] == [
            ("auto", []),
            ("gpt-5.5", []),
        ]

    def test_claude_rows_keep_their_window_variants(self):
        """The claude namespace's ``[1m]`` ids are windows, not efforts: the
        picker lists them as they are and the effort levels ride separately."""
        model_registry.refresh_advertised_models("claude_code", ["opus[1m]", "sonnet"])
        rows = agents._cc_models(_request(), configured_default="")
        names = [r["model_name"] for r in rows]
        # The registry keeps the 1M variant as its own row (canonical ``-1m``
        # spelling); nothing read the bracket as an effort and collapsed it.
        assert names[0] == "auto"
        assert any("1m" in n for n in names[1:])
        assert all(split_effort_model_id(n)[1] is None for n in names)
        assert all(r["effort_levels"] == [] for r in rows)


class TestEffortLevelsEndpoint:
    async def _get(self, state, query: str):
        app = web.Application()
        app["state"] = state
        app.router.add_get("/api/effort-levels", agents.api_effort_levels)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/api/effort-levels" + query)
            return await resp.json()

    @pytest.mark.asyncio
    async def test_a_codex_slot_with_a_live_session_answers_its_own_levels(self, tmp_path):
        client = _codex_client(tmp_path)
        client._store_session_config(CODEX_SESSION_NEW_WITH_ENVELOPE)
        provider = _provider_for(client, ACP_BACKEND_CODEX)
        state = MagicMock()
        state.sessions.get_provider = MagicMock(return_value=provider)
        state._slots = {}
        assert await self._get(state, "?slot=s1") == [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
        ]

    @pytest.mark.asyncio
    async def test_a_codex_slot_without_a_live_session_borrows_another_codex_sessions(
        self, tmp_path
    ):
        client = _codex_client(tmp_path)
        client._store_session_config(CODEX_SESSION_NEW_WITH_ENVELOPE)
        live_elsewhere = _provider_for(client, ACP_BACKEND_CODEX)
        state = MagicMock()
        state.sessions.get_provider = MagicMock(return_value=None)
        state.sessions.active_providers = MagicMock(return_value=[live_elsewhere])
        state._slots = {"s1": SimpleNamespace(acp_backend=ACP_BACKEND_CODEX)}
        assert await self._get(state, "?slot=s1") == [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
        ]

    @pytest.mark.asyncio
    async def test_a_kiro_slot_without_a_live_session_keeps_the_global_list(self, tmp_path):
        from kiro_crew.dashboard.chat_persistence import get_reasoning_effort_ordered

        state = MagicMock()
        state.sessions.get_provider = MagicMock(return_value=None)
        state.sessions.active_providers = MagicMock(return_value=[])
        state._slots = {"s1": SimpleNamespace(acp_backend=ACP_BACKEND_KIRO)}
        assert await self._get(state, "?slot=s1") == get_reasoning_effort_ordered()


class TestPickComposition:
    """Model X + effort E on a codex slot = ``model=X`` and
    ``reasoning_effort=E`` over ``session/set_config_option``; never ``X[E]``."""

    def test_each_harness_names_its_own_effort_option(self):
        assert effort_option_id_for(ACP_BACKEND_CLAUDE) == "effort"
        assert effort_option_id_for(ACP_BACKEND_CODEX) == "reasoning_effort"
        assert effort_option_id_for(ACP_BACKEND_KIRO) == "effort"

    @pytest.mark.asyncio
    async def test_model_then_effort_reach_the_adapter_as_two_options(self, tmp_path):
        from kiro_crew.providers.acp import AcpProvider

        client = _codex_client(tmp_path)
        client._capture_available_models(CODEX_SESSION_NEW_WITH_ENVELOPE)
        client._store_session_config(CODEX_SESSION_NEW_WITH_ENVELOPE)
        pushed: list[tuple[str, str]] = []

        async def _set(config_id: str, value: str) -> None:
            pushed.append((config_id, value))

        client.set_config_option = _set  # type: ignore[method-assign]
        client._write_claude_local_settings = MagicMock()

        await client.set_model("gpt-6-astra")
        assert client._model == "gpt-6-astra"

        provider = AcpProvider.__new__(AcpProvider)
        provider._client = client
        provider._effort_per_model = {}
        provider._effort_defaults = None
        provider._apply_effort_overlay = MagicMock()
        assert provider.supports_effort() is True
        assert await provider.change_effort("ultra") is True

        assert pushed == [("model", "gpt-6-astra"), ("reasoning_effort", "ultra")]
        assert not any("[" in value for _, value in pushed)

    def test_a_persisted_composite_pin_falls_back_to_its_base(self):
        assert AcpClient._model_config_candidates("gpt-5.6-sol[medium]") == [
            "gpt-5.6-sol[medium]",
            "gpt-5.6-sol",
        ]
        assert AcpClient._model_config_candidates("opus[1m]") == ["opus[1m]", "opus"]
