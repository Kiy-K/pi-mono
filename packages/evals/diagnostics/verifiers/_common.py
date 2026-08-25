"""Shared module loading for task verifiers.

Verifiers otherwise stay single-file so run-manifest hashes cover them
entirely; this helper is the one sanctioned shared dependency, and
benchmark provenance hashes it alongside each verifier.
"""

import importlib.util
import sys


def load_module(root, name):
	"""Load <root>/<name>.py as a module, registering it in sys.modules
	BEFORE executing: dataclasses resolves cls.__module__ through
	sys.modules, so submissions using `from __future__ import annotations`
	with @dataclass crash with AttributeError otherwise. Cached: repeated
	loads of the same name share one module object."""
	if name in sys.modules:
		return sys.modules[name]
	spec = importlib.util.spec_from_file_location(name, root / f"{name}.py")
	module = importlib.util.module_from_spec(spec)
	sys.modules[name] = module
	spec.loader.exec_module(module)
	return module
