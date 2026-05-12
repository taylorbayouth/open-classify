import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CatalogError, loadCatalog, validateCatalog } from "../dist/src/catalog.js";

const VALID_MODEL = {
  id: "gpt-5.5",
  specializations: ["reasoning", "coding"],
  execution_modes: ["direct", "tool_assisted"],
  tier: "frontier_strong",
  params_in_billions: 800,
  context_window: 1_000_000,
};

const VALID_CATALOG = {
  models: [VALID_MODEL],
  default: "gpt-5.5",
};

function withTempFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-catalog-"));
  const path = join(dir, "downstream-models.json");
  writeFileSync(path, contents);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadCatalog throws when file does not exist", () => {
  assert.throws(
    () => loadCatalog("/nonexistent/path/downstream-models.json"),
    (error) =>
      error instanceof CatalogError && /catalog file not found/.test(error.message),
  );
});

test("loadCatalog throws on unparseable JSON", () => {
  withTempFile("{not json", (path) => {
    assert.throws(
      () => loadCatalog(path),
      (error) =>
        error instanceof CatalogError &&
        /failed to parse catalog JSON/.test(error.message),
    );
  });
});

test("loadCatalog accepts a well-formed catalog", () => {
  withTempFile(JSON.stringify(VALID_CATALOG), (path) => {
    const catalog = loadCatalog(path);
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].id, "gpt-5.5");
    assert.equal(catalog.default, "gpt-5.5");
  });
});

test("validateCatalog rejects empty models array", () => {
  assert.throws(
    () => validateCatalog({ models: [], default: "x" }),
    (error) => error instanceof CatalogError && /non-empty array/.test(error.message),
  );
});

test("validateCatalog rejects missing required field on an entry", () => {
  const bad = { models: [{ ...VALID_MODEL, params_in_billions: undefined }], default: VALID_MODEL.id };
  assert.throws(
    () => validateCatalog(bad),
    (error) =>
      error instanceof CatalogError &&
      /params_in_billions/.test(error.message),
  );
});

test("validateCatalog rejects unsupported specialization value", () => {
  const bad = {
    models: [{ ...VALID_MODEL, specializations: ["not_a_real_spec"] }],
    default: VALID_MODEL.id,
  };
  assert.throws(
    () => validateCatalog(bad),
    (error) =>
      error instanceof CatalogError &&
      /specializations\[0\] must be one of/.test(error.message),
  );
});

test("validateCatalog rejects unsupported tier value", () => {
  const bad = {
    models: [{ ...VALID_MODEL, tier: "unable_to_determine" }],
    default: VALID_MODEL.id,
  };
  assert.throws(
    () => validateCatalog(bad),
    (error) =>
      error instanceof CatalogError &&
      /tier must be one of/.test(error.message) &&
      !/unable_to_determine/.test(error.message.split(":")[0]),
  );
});

test("validateCatalog rejects duplicate model ids", () => {
  const bad = {
    models: [VALID_MODEL, { ...VALID_MODEL }],
    default: VALID_MODEL.id,
  };
  assert.throws(
    () => validateCatalog(bad),
    (error) => error instanceof CatalogError && /duplicated/.test(error.message),
  );
});

test("validateCatalog rejects default that does not reference a real id", () => {
  assert.throws(
    () => validateCatalog({ models: [VALID_MODEL], default: "missing-model" }),
    (error) =>
      error instanceof CatalogError &&
      /default "missing-model" must reference an existing models\[\]\.id/.test(error.message),
  );
});

test("validateCatalog rejects unsupported top-level field", () => {
  assert.throws(
    () => validateCatalog({ ...VALID_CATALOG, extra: 1 }),
    (error) =>
      error instanceof CatalogError && /unsupported field "extra"/.test(error.message),
  );
});

test("validateCatalog rejects unsupported field on an entry", () => {
  const bad = {
    models: [{ ...VALID_MODEL, color: "blue" }],
    default: VALID_MODEL.id,
  };
  assert.throws(
    () => validateCatalog(bad),
    (error) =>
      error instanceof CatalogError && /unsupported field "color"/.test(error.message),
  );
});

test("validateCatalog rejects old tiers array", () => {
  const bad = {
    models: [{ ...VALID_MODEL, tiers: ["frontier_strong"] }],
    default: VALID_MODEL.id,
  };
  assert.throws(
    () => validateCatalog(bad),
    (error) =>
      error instanceof CatalogError &&
      /unsupported field "tiers"/.test(error.message),
  );
});

test("validateCatalog rejects non-positive params_in_billions", () => {
  const bad = {
    models: [{ ...VALID_MODEL, params_in_billions: 0 }],
    default: VALID_MODEL.id,
  };
  assert.throws(
    () => validateCatalog(bad),
    (error) =>
      error instanceof CatalogError &&
      /params_in_billions must be a positive number/.test(error.message),
  );
});

test("validateCatalog accepts all pricing fields together", () => {
  const catalog = validateCatalog({
    models: [
      {
        ...VALID_MODEL,
        input_tokens_cpm: 5,
        cached_tokens_cpm: 0.5,
        output_tokens_cpm: 25,
      },
    ],
    default: VALID_MODEL.id,
  });
  assert.equal(catalog.models[0].input_tokens_cpm, 5);
  assert.equal(catalog.models[0].cached_tokens_cpm, 0.5);
  assert.equal(catalog.models[0].output_tokens_cpm, 25);
});

test("validateCatalog rejects partial pricing fields", () => {
  const bad = {
    models: [{ ...VALID_MODEL, input_tokens_cpm: 5 }],
    default: VALID_MODEL.id,
  };
  assert.throws(
    () => validateCatalog(bad),
    (error) =>
      error instanceof CatalogError &&
      /pricing fields must be provided all together/.test(error.message),
  );
});
