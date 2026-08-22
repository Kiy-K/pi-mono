"""Pipeline runner. Required behavior: SPEC.md."""
from stages import STAGES
from errors import CycleError, StageFailureError


class Pipeline:
    def __init__(self, edges):
        raise NotImplementedError("implement per SPEC.md")

    def execute(self, entry_payload, stop_on_error=True):
        raise NotImplementedError("implement per SPEC.md")
