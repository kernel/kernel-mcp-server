import importlib.util
import json
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("verify-smoke.py")
SPEC = importlib.util.spec_from_file_location("verify_smoke", MODULE_PATH)
assert SPEC and SPEC.loader
verify_smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_smoke)

FIXTURES = Path(__file__).with_name("fixtures")


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


class VerifySmokeTest(unittest.TestCase):
    def test_accepts_native_calls_with_paired_observations(self) -> None:
        proof = verify_smoke.validate_trajectory(
            load_fixture("trajectory-positive.json"), "project-123"
        )

        self.assertTrue(proof["native_calls_present"])
        self.assertTrue(proof["observations_valid"])
        self.assertTrue(proof["context_scope_valid"])
        self.assertTrue(proof["manage_browsers_arguments_valid"])

    def test_accepts_codex_serialized_observations(self) -> None:
        proof = verify_smoke.validate_trajectory(
            load_fixture("trajectory-codex-observation.json"), "project-123"
        )

        self.assertTrue(proof["native_calls_present"])
        self.assertTrue(proof["observations_valid"])
        self.assertTrue(proof["context_scope_valid"])
        self.assertTrue(proof["manage_browsers_arguments_valid"])

    def test_rejects_missing_observation(self) -> None:
        proof = verify_smoke.validate_trajectory(
            load_fixture("trajectory-missing-observation.json"), "project-123"
        )

        self.assertFalse(proof["observations_valid"])
        self.assertEqual(proof["missing_observations"], ["browsers-1"])

    def test_rejects_error_observation(self) -> None:
        proof = verify_smoke.validate_trajectory(
            load_fixture("trajectory-error-observation.json"), "project-123"
        )

        self.assertFalse(proof["observations_valid"])
        self.assertEqual(proof["error_observations"], ["browsers-1"])


if __name__ == "__main__":
    unittest.main()
