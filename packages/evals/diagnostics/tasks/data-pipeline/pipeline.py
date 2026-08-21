"""Wire parser, validator, and transformer into a pipeline. Required behavior: SPEC.md."""
import parser
import validator
import transformer


def run(text: str) -> tuple[list[str], dict[str, int]]:
    """Run the full pipeline: parse, validate, transform. Return (output, stats)."""
    raise NotImplementedError("implement per SPEC.md")