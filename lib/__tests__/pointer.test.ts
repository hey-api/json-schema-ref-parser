import { describe, expect, it } from "vitest";
import { $RefParser } from "..";
import path from "path";

describe("pointer", () => {
  it("inlines internal JSON Pointer refs under #/paths/ for OpenAPI bundling", async () => {
    const refParser = new $RefParser();
    const pathOrUrlOrSchema = path.resolve("lib", "__tests__", "spec", "openapi-paths-ref.json");
    const schema = (await refParser.bundle({ pathOrUrlOrSchema })) as any;

    // The GET endpoint should have its schema defined inline
    const getSchema = schema.paths["/foo"].get.responses["200"].content["application/json"].schema;
    expect(getSchema.$ref).toBeUndefined();
    expect(getSchema.type).toBe("object");
    expect(getSchema.properties.bar.type).toBe("string");

    // The POST endpoint should have its schema inlined (copied) instead of a $ref
    const postSchema = schema.paths["/foo"].post.responses["200"].content["application/json"].schema;
    expect(postSchema.$ref).toBeUndefined();
    expect(postSchema.type).toBe("object");
    expect(postSchema.properties.bar.type).toBe("string");

    // Both schemas should be identical objects
    expect(postSchema).toEqual(getSchema);
  });
});
