"""Research report invariants, using synthetic ratings and no provider calls."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'comparison', Path(__file__).resolve().parents[1] / 'scripts/summarize-committee-comparison.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def fixture(count=40):
    calls = []
    for stage in ['paper_role', 'paper_risk']:
        calls.append(dict(stage=stage, **{key: 'same' for key in [
            'evidenceHash', 'policyHash', 'snapshotHash', 'promptHash', 'schemaHash',
            'userMessageHash', 'reasoningEffort', 'maxCompletionTokens']}))
    role = [dict(candidate=i, confidence=90, reject=False, aggressiveFit=75) for i in range(count)]
    risk = [dict(candidate=i, confidence=90, pathRisk=20) for i in range(count)]
    return {
        'report': dict(researchOnly=True, researchContract=f'research-{count}-v1',
                       finalists=count, provider='left', requestedModel='test-model',
                       modelCalls=calls, manifest=dict(status='VALID', sources=[]),
                       asOf='2026-10-07T05:51:45Z', agentTimeoutMs=900000,
                       serial=True, stageSpacingMs=65000, stageFailures=[]),
        'run': {'review': {
            'audit': [dict(stage=s, output=dict(modelConfigHash='config', results=r))
                      for s, r in [('role', role), ('risk', risk), ('redteam', [])]],
            'summary': [dict(candidate=i, metrics={}, kind='TRADER', gate=dict(reasons=[]))
                        for i in range(count)]}}}


class ReportTests(unittest.TestCase):
    def compare(self, left, right):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ['left.json', 'right.json']]
            for path, value in zip(paths, [left, right]):
                path.write_text(json.dumps(value))
            return comparison.compare(paths)

    def test_matching_top40(self):
        a = fixture(); b = copy.deepcopy(a); b['report']['provider'] = 'right'
        result = self.compare(a, b)
        self.assertEqual(result['agreement']['binaryAgreement'], 1)
        self.assertEqual(result['models'][0]['candidatePass'], 40)
        self.assertTrue(result['models'][0]['committeeComplete'])

    def test_missing_ratings_is_unavailable(self):
        a = fixture(); b = copy.deepcopy(a); b['run']['review']['audit'] = []
        result = self.compare(a, b)
        self.assertIsNone(result['models'][1]['candidatePass'])
        self.assertNotIn('agreement', result)

    def test_redteam_failure_is_not_complete_committee(self):
        a = fixture(); b = copy.deepcopy(a)
        b['run']['review']['audit'].pop()
        b['report']['stageFailures'] = ['redteam timeout']
        result = self.compare(a, b)
        self.assertEqual(result['models'][1]['candidatePass'], 40)
        self.assertFalse(result['models'][1]['committeeComplete'])

    def test_different_evidence_refused(self):
        a = fixture(); b = copy.deepcopy(a)
        b['report']['modelCalls'][0]['evidenceHash'] = 'different'
        with self.assertRaises(ValueError): self.compare(a, b)

    def test_different_cohort_refused(self):
        with self.assertRaises(ValueError): self.compare(fixture(), fixture(35))

    def test_incomplete_summaries_refused(self):
        a = fixture(); b = copy.deepcopy(a); b['run']['review']['summary'].pop()
        with self.assertRaises(ValueError): self.compare(a, b)

    def test_preparation_is_not_a_model_run(self):
        a = fixture(); b = copy.deepcopy(a); b['report']['preparedOnly'] = True
        with self.assertRaises(ValueError): self.compare(a, b)


if __name__ == '__main__':
    unittest.main()
