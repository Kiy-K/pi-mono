"""Stage registry. Required behavior: SPEC.md."""

STAGES = {}


def stage(name):
    raise NotImplementedError("implement per SPEC.md")


def run_stage(name, payload):
    raise NotImplementedError("implement per SPEC.md")
