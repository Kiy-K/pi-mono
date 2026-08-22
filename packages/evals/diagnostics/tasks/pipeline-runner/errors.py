"""Exception types. Required behavior: SPEC.md."""


class CycleError(Exception):
    pass


class StageFailureError(Exception):
    def __init__(self, stage):
        super().__init__(stage)
        self.stage = stage
