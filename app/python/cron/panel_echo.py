"""Small native bridge. App code stays outside HERMES_HOME; cron remains native."""
import importlib.util
import sys
from pathlib import Path

_root = Path(__file__).resolve().parents[2] / 'server/echo'
_name = '_hermes_panel_echo'
if _name not in sys.modules:
    _spec = importlib.util.spec_from_file_location(_name, _root / '__init__.py', submodule_search_locations=[str(_root)])
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_name] = _module
    _spec.loader.exec_module(_module)
from _hermes_panel_echo.runtime import guarded, script_result, session_started, session_finishing, agent_started, child_env, rewrite_command
