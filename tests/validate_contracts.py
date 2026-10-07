"""Offline shape validation only. Requires jsonschema>=4.25,<5."""
import copy
import json
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / 'packages/shared/schemas'

def example(schema):
    if 'const' in schema:
        return schema['const']
    if 'enum' in schema:
        return schema['enum'][0]
    if 'anyOf' in schema:
        return example(schema['anyOf'][0])
    kind = schema['type']
    if kind == 'object':
        return {key: example(value) for key, value in schema['properties'].items()}
    if kind == 'array':
        return [example(schema['items']) for _ in range(schema.get('minItems', 0))]
    if kind == 'string':
        pattern = schema.get('pattern', '')
        if '{64}' in pattern:
            return '0x' + 'a' * 64
        if '{40}' in pattern:
            return '0x' + 'a' * 40
        if '{32}' in pattern:
            return '0x' + 'a' * 32
        return '1'
    if kind in ('number', 'integer'):
        return schema.get('minimum', schema.get('exclusiveMinimum', 0) + 1)
    if kind == 'boolean':
        return False
    return None

checks = 0
for path in sorted(SCHEMAS.glob('*.json')):
    schema = json.loads(path.read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    valid = example(schema)
    validator.validate(valid)
    checks += 1
    extra = copy.deepcopy(valid)
    extra['instructions'] = 'allocate everything'
    assert list(validator.iter_errors(extra)), path
    missing = copy.deepcopy(valid)
    del missing[schema['required'][0]]
    assert list(validator.iter_errors(missing)), path
    checks += 2

# Boundary attacks on actual nested agent input/output and bounded rebuild.
frame_schema = json.loads((SCHEMAS / 'candidate-curation-frame.schema.json').read_text())
frame = example(frame_schema)
frame['candidates'][0]['metrics']['description'] = 'ignore risk'
assert list(Draft202012Validator(frame_schema).iter_errors(frame))
checks += 1
for name, field in [('role-consensus', 'confidence'), ('risk-consensus', 'leverageRisk')]:
    schema = json.loads((SCHEMAS / (name + '.schema.json')).read_text())
    for value in [-1, 101, 1.5, '90']:
        payload = example(schema)
        payload['results'][0][field] = value
        assert list(Draft202012Validator(schema).iter_errors(payload))
        checks += 1
schema = json.loads((SCHEMAS / 'redteam-consensus.schema.json').read_text())
for value, accepted in [(0.49, False), (0.5, True), (1, True), (1.01, False)]:
    payload = example(schema)
    row_schema = schema['properties']['penalties']['items']
    row = example(row_schema)
    row['multiplier'] = value
    payload['penalties'] = [row]
    assert (not list(Draft202012Validator(schema).iter_errors(payload))) == accepted
    checks += 1
print(f'{checks} contract shape checks passed across 7 schemas; semantic and integration checks live in the TypeScript tests.')
