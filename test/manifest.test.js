// Ties the manifest to the code: versions, config defaults, actions, scene triggers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, REGION_BASE_URLS } from '../src/config.js';

const read = async (path) => readFile(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('../gladys-assistant-integration.json'));
const pkg = JSON.parse(await read('../package.json'));
const controllerSource = await read('../src/controller.js');
const handlersSource = await read('../src/handlers.js');

test('versions agree', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('config_schema keys and defaults mirror DEFAULT_CONFIG', () => {
  const fields = manifest.config_schema.filter((f) => f.type !== 'section');
  assert.deepEqual(fields.map((f) => f.key).sort(), Object.keys(DEFAULT_CONFIG).sort());
  for (const field of fields) {
    if (field.default !== undefined)
      assert.equal(field.default, DEFAULT_CONFIG[field.key], field.key);
  }
  const region = fields.find((f) => f.key === 'region');
  assert.deepEqual(region.options.map((o) => o.value).sort(), Object.keys(REGION_BASE_URLS).sort());
});

test('every action has a handler', () => {
  for (const action of manifest.actions)
    assert.ok(handlersSource.includes(`'${action.key}'`), action.key);
});

test('every fired scene trigger is declared, with its data keys', () => {
  const fired = [...controllerSource.matchAll(/sceneEvent\('([a-z_]+)', \{([^}]*)\}/g)];
  assert.ok(fired.length >= 3);
  for (const [, key, body] of fired) {
    const trigger = manifest.scene_triggers.find((t) => t.key === key);
    assert.ok(trigger, `${key} is declared`);
    const declared = new Set(
      [...(trigger.fields ?? []), ...(trigger.variables ?? [])].map((f) => f.key),
    );
    for (const [, dataKey] of body.matchAll(/(\w+):/g))
      assert.ok(declared.has(dataKey), `${key}.${dataKey}`);
  }
});

test('catalog descriptions and texts are within the store limits', () => {
  for (const text of Object.values(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, text);
  }
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});
