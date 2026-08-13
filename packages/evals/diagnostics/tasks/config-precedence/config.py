from collections.abc import Mapping
from typing import Any


def resolve_config(
    defaults: Mapping[str, Any],
    file_values: Mapping[str, Any],
    environment: Mapping[str, Any],
    cli: Mapping[str, Any],
) -> dict[str, Any]:
    """Resolve configuration with CLI taking highest precedence."""
    return {**defaults, **cli, **environment, **file_values}
