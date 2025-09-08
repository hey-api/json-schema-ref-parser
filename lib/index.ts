import $Refs from "./refs.js";
import { newFile, parseFile } from "./parse.js";
import { resolveExternal } from "./resolve-external.js";
import { bundle as _bundle } from "./bundle.js";
import _dereference from "./dereference.js";
import * as url from "./util/url.js";
import { isHandledError, JSONParserErrorGroup } from "./util/errors.js";
import { ono } from "@jsdevtools/ono";
import { getJsonSchemaRefParserDefaultOptions } from "./options.js";
import type { JSONSchema } from "./types/index.js";
import { urlResolver } from "./resolvers/url.js";
import { fileResolver } from "./resolvers/file.js";

interface ResolvedInput {
  path: string;
  schema: string | JSONSchema | Buffer | Awaited<JSONSchema> | undefined;
  type: "file" | "json" | "url";
}

export const getResolvedInput = ({
  pathOrUrlOrSchema,
}: {
  pathOrUrlOrSchema: JSONSchema | string | unknown;
}): ResolvedInput => {
  if (!pathOrUrlOrSchema) {
    throw ono(`Expected a file path, URL, or object. Got ${pathOrUrlOrSchema}`);
  }

  const resolvedInput: ResolvedInput = {
    path: typeof pathOrUrlOrSchema === "string" ? pathOrUrlOrSchema : "",
    schema: undefined,
    type: "url",
  };

  // If the path is a filesystem path, then convert it to a URL.
  // NOTE: According to the JSON Reference spec, these should already be URLs,
  // but, in practice, many people use local filesystem paths instead.
  // So we're being generous here and doing the conversion automatically.
  // This is not intended to be a 100% bulletproof solution.
  // If it doesn't work for your use-case, then use a URL instead.
  if (resolvedInput.path && url.isFileSystemPath(resolvedInput.path)) {
    resolvedInput.path = url.fromFileSystemPath(resolvedInput.path);
    resolvedInput.type = "file";
  } else if (!resolvedInput.path && pathOrUrlOrSchema && typeof pathOrUrlOrSchema === "object") {
    if ("$id" in pathOrUrlOrSchema && pathOrUrlOrSchema.$id) {
      // when schema id has defined an URL should use that hostname to request the references,
      // instead of using the current page URL
      const { hostname, protocol } = new URL(pathOrUrlOrSchema.$id as string);
      resolvedInput.path = `${protocol}//${hostname}:${protocol === "https:" ? 443 : 80}`;
      resolvedInput.type = "url";
    } else {
      resolvedInput.schema = pathOrUrlOrSchema;
      resolvedInput.type = "json";
    }
  }

  if (resolvedInput.type !== "json") {
    // resolve the absolute path of the schema
    resolvedInput.path = url.resolve(url.cwd(), resolvedInput.path);
  }

  return resolvedInput;
};

const _ensureResolvedInputPath = (input: ResolvedInput, fallbackPath: string): ResolvedInput => {
  if (input.type === "json" && (!input.path || input.path.length === 0)) {
    return { ...input, path: fallbackPath };
  }
  return input;
};

// NOTE: previously used helper removed as unused

/**
 * This class parses a JSON schema, builds a map of its JSON references and their resolved values,
 * and provides methods for traversing, manipulating, and dereferencing those references.
 */
export class $RefParser {
  /**
   * The resolved JSON references
   *
   * @type {$Refs}
   * @readonly
   */
  $refs = new $Refs<JSONSchema>();
  public options = getJsonSchemaRefParserDefaultOptions();
  /**
   * The parsed (and possibly dereferenced) JSON schema object
   *
   * @type {object}
   * @readonly
   */
  public schema: JSONSchema | null = null;
  public schemaMany: JSONSchema[] = [];
  public schemaManySources: string[] = [];
  public sourcePathToPrefix: Map<string, string> = new Map();

  /**
   * Bundles all referenced files/URLs into a single schema that only has internal `$ref` pointers. This lets you split-up your schema however you want while you're building it, but easily combine all those files together when it's time to package or distribute the schema to other people. The resulting schema size will be small, since it will still contain internal JSON references rather than being fully-dereferenced.
   *
   * This also eliminates the risk of circular references, so the schema can be safely serialized using `JSON.stringify()`.
   *
   * See https://apitools.dev/json-schema-ref-parser/docs/ref-parser.html#bundleschema-options-callback
   *
   * @param pathOrUrlOrSchema A JSON Schema object, or the file path or URL of a JSON Schema file.
   */
  public async bundle({
    arrayBuffer,
    fetch,
    pathOrUrlOrSchema,
    resolvedInput,
  }: {
    arrayBuffer?: ArrayBuffer;
    fetch?: RequestInit;
    pathOrUrlOrSchema: JSONSchema | string | unknown;
    resolvedInput?: ResolvedInput;
  }): Promise<JSONSchema> {
    await this.parse({
      arrayBuffer,
      fetch,
      pathOrUrlOrSchema,
      resolvedInput,
    });

    await resolveExternal(this, this.options);
    const errors = JSONParserErrorGroup.getParserErrors(this);
    if (errors.length > 0) {
      throw new JSONParserErrorGroup(this);
    }
    _bundle(this, this.options);
    const errors2 = JSONParserErrorGroup.getParserErrors(this);
    if (errors2.length > 0) {
      throw new JSONParserErrorGroup(this);
    }
    return this.schema!;
  }

  /**
   * Bundles multiple roots (files/URLs/objects) into a single schema by creating a synthetic root
   * that references each input, resolving all externals, and then hoisting via the existing bundler.
   */
  public async bundleMany({
    arrayBuffer,
    fetch,
    pathOrUrlOrSchemas,
    resolvedInputs,
  }: {
    arrayBuffer?: ArrayBuffer[];
    fetch?: RequestInit;
    pathOrUrlOrSchemas: Array<JSONSchema | string | unknown>;
    resolvedInputs?: ResolvedInput[];
  }): Promise<JSONSchema> {
    await this.parseMany({ arrayBuffer, fetch, pathOrUrlOrSchemas, resolvedInputs });
    this.mergeMany();

    await resolveExternal(this, this.options);
    const errors = JSONParserErrorGroup.getParserErrors(this);
    if (errors.length > 0) {
      throw new JSONParserErrorGroup(this);
    }
    _bundle(this, this.options);
    // Merged root is ready for bundling

    const errors2 = JSONParserErrorGroup.getParserErrors(this);
    if (errors2.length > 0) {
      throw new JSONParserErrorGroup(this);
    }
    return this.schema!;
  }

  /**
   * Dereferences all `$ref` pointers in the JSON Schema, replacing each reference with its resolved value. This results in a schema object that does not contain any `$ref` pointers. Instead, it's a normal JavaScript object tree that can easily be crawled and used just like any other JavaScript object. This is great for programmatic usage, especially when using tools that don't understand JSON references.
   *
   * The dereference method maintains object reference equality, meaning that all `$ref` pointers that point to the same object will be replaced with references to the same object. Again, this is great for programmatic usage, but it does introduce the risk of circular references, so be careful if you intend to serialize the schema using `JSON.stringify()`. Consider using the bundle method instead, which does not create circular references.
   *
   * See https://apitools.dev/json-schema-ref-parser/docs/ref-parser.html#dereferenceschema-options-callback
   *
   * @param pathOrUrlOrSchema A JSON Schema object, or the file path or URL of a JSON Schema file.
   */
  public async dereference({
    fetch,
    pathOrUrlOrSchema,
  }: {
    fetch?: RequestInit;
    pathOrUrlOrSchema: JSONSchema | string | unknown;
  }): Promise<JSONSchema> {
    await this.parse({
      fetch,
      pathOrUrlOrSchema,
    });
    await resolveExternal(this, this.options);
    const errors = JSONParserErrorGroup.getParserErrors(this);
    if (errors.length > 0) {
      throw new JSONParserErrorGroup(this);
    }
    _dereference(this, this.options);
    const errors2 = JSONParserErrorGroup.getParserErrors(this);
    if (errors2.length > 0) {
      throw new JSONParserErrorGroup(this);
    }
    return this.schema!;
  }

  /**
   * Parses the given JSON schema.
   * This method does not resolve any JSON references.
   * It just reads a single file in JSON or YAML format, and parse it as a JavaScript object.
   *
   * @param pathOrUrlOrSchema A JSON Schema object, or the file path or URL of a JSON Schema file.
   * @returns - The returned promise resolves with the parsed JSON schema object.
   */
  public async parse({
    arrayBuffer,
    fetch,
    pathOrUrlOrSchema,
    resolvedInput: _resolvedInput,
  }: {
    arrayBuffer?: ArrayBuffer;
    fetch?: RequestInit;
    pathOrUrlOrSchema: JSONSchema | string | unknown;
    resolvedInput?: ResolvedInput;
  }): Promise<{ schema: JSONSchema }> {
    const resolvedInput = _resolvedInput || getResolvedInput({ pathOrUrlOrSchema });
    const { path, type } = resolvedInput;
    let { schema } = resolvedInput;

    // reset everything
    this.schema = null;
    this.$refs = new $Refs();

    if (schema) {
      // immediately add a new $Ref with the schema object as value
      const $ref = this.$refs._add(path);
      $ref.pathType = url.isFileSystemPath(path) ? "file" : "http";
      $ref.value = schema;
    } else if (type !== "json") {
      const file = newFile(path);

      // Add a new $Ref for this file, even though we don't have the value yet.
      // This ensures that we don't simultaneously read & parse the same file multiple times
      const $refAdded = this.$refs._add(file.url);
      $refAdded.pathType = type;
      try {
        const resolver = type === "file" ? fileResolver : urlResolver;
        await resolver.handler({
          arrayBuffer,
          fetch,
          file,
        });
        const parseResult = await parseFile(file, this.options);
        $refAdded.value = parseResult.result;
        schema = parseResult.result;
      } catch (err) {
        if (isHandledError(err)) {
          $refAdded.value = err;
        }

        throw err;
      }
    }

    if (schema === null || typeof schema !== "object" || Buffer.isBuffer(schema)) {
      throw ono.syntax(`"${this.$refs._root$Ref.path || schema}" is not a valid JSON Schema`);
    }

    this.schema = schema;

    return {
      schema,
    };
  }

  private async parseMany({
    arrayBuffer,
    fetch,
    pathOrUrlOrSchemas,
    resolvedInputs: _resolvedInputs,
  }: {
    arrayBuffer?: ArrayBuffer[];
    fetch?: RequestInit;
    pathOrUrlOrSchemas: Array<JSONSchema | string | unknown>;
    resolvedInputs?: ResolvedInput[];
  }): Promise<{ schemaMany: JSONSchema[] }> {
    const resolvedInputs = [...(_resolvedInputs || [])];
    resolvedInputs.push(...(pathOrUrlOrSchemas.map((schema) => getResolvedInput({ pathOrUrlOrSchema: schema })) || []));

    this.schemaMany = [];
    this.schemaManySources = [];
    this.sourcePathToPrefix = new Map();

    for (let i = 0; i < resolvedInputs.length; i++) {
      const resolvedInput = resolvedInputs[i];
      const { path, type } = resolvedInput;
      let { schema } = resolvedInput;

      if (schema) {
        // keep schema as-is
      } else if (type !== "json") {
        const file = newFile(path);

        // Add a new $Ref for this file, even though we don't have the value yet.
        // This ensures that we don't simultaneously read & parse the same file multiple times
        const $refAdded = this.$refs._add(file.url);
        $refAdded.pathType = type;
        try {
          const resolver = type === "file" ? fileResolver : urlResolver;
          await resolver.handler({
            arrayBuffer: arrayBuffer?.[i],
            fetch,
            file,
          });
          const parseResult = await parseFile(file, this.options);
          $refAdded.value = parseResult.result;
          schema = parseResult.result;
        } catch (err) {
          if (isHandledError(err)) {
            $refAdded.value = err;
          }

          throw err;
        }
      }

      if (schema === null || typeof schema !== "object" || Buffer.isBuffer(schema)) {
        throw ono.syntax(`"${this.$refs._root$Ref.path || schema}" is not a valid JSON Schema`);
      }

      this.schemaMany.push(schema);
      this.schemaManySources.push(path && path.length ? path : url.cwd());
    }

    return {
      schemaMany: this.schemaMany,
    };
  }

  public mergeMany(): JSONSchema {
    const schemas = this.schemaMany || [];
    if (schemas.length === 0) {
      throw ono("mergeMany called with no schemas. Did you run parseMany?");
    }

    const first: any = schemas[0] || {};
    const merged: any = {};

    if (typeof first.openapi === "string") {
      merged.openapi = first.openapi;
    }
    if (typeof first.swagger === "string") {
      merged.swagger = first.swagger;
    }
    if (first.info) {
      merged.info = JSON.parse(JSON.stringify(first.info));
    }
    if (first.servers) {
      merged.servers = JSON.parse(JSON.stringify(first.servers));
    }

    merged.paths = {};
    merged.components = {};

    const componentSections = [
      "schemas",
      "parameters",
      "requestBodies",
      "responses",
      "headers",
      "securitySchemes",
      "examples",
      "links",
      "callbacks",
    ];
    for (const sec of componentSections) {
      merged.components[sec] = {};
    }

    const tagNameSet = new Set<string>();
    const tags: any[] = [];
    const usedOpIds = new Set<string>();

    const baseName = (p: string) => {
      try {
        const withoutHash = p.split("#")[0];
        const parts = withoutHash.split("/");
        const filename = parts[parts.length - 1] || "schema";
        const dot = filename.lastIndexOf(".");
        const raw = dot > 0 ? filename.substring(0, dot) : filename;
        return raw.replace(/[^A-Za-z0-9_-]/g, "_");
      } catch {
        return "schema";
      }
    };
    const unique = (set: Set<string>, proposed: string) => {
      let name = proposed;
      let i = 2;
      while (set.has(name)) {
        name = `${proposed}_${i++}`;
      }
      set.add(name);
      return name;
    };

    const rewriteRef = (ref: string, refMap: Map<string, string>): string => {
      // OAS3: #/components/{section}/{name}...
      let m = ref.match(/^#\/components\/([^/]+)\/([^/]+)(.*)$/);
      if (m) {
        const base = `#/components/${m[1]}/${m[2]}`;
        const mapped = refMap.get(base);
        if (mapped) {
          return mapped + (m[3] || "");
        }
      }
      // OAS2: #/definitions/{name}...
      m = ref.match(/^#\/definitions\/([^/]+)(.*)$/);
      if (m) {
        const base = `#/components/schemas/${m[1]}`;
        const mapped = refMap.get(base);
        if (mapped) {
          // map definitions -> components/schemas
          return mapped + (m[2] || "");
        }
      }
      return ref;
    };

    const cloneAndRewrite = (
      obj: any,
      refMap: Map<string, string>,
      tagMap: Map<string, string>,
      opIdPrefix: string,
      basePath: string,
    ): any => {
      if (obj === null || obj === undefined) {
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map((v) => cloneAndRewrite(v, refMap, tagMap, opIdPrefix, basePath));
      }
      if (typeof obj !== "object") {
        return obj;
      }

      const out: any = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$ref" && typeof v === "string") {
          const s = v as string;
          if (s.startsWith("#")) {
            out[k] = rewriteRef(s, refMap);
          } else {
            const proto = url.getProtocol(s);
            if (proto === undefined) {
              // relative external ref -> absolutize against source base path
              out[k] = url.resolve(basePath + "#", s);
            } else {
              out[k] = s;
            }
          }
        } else if (k === "tags" && Array.isArray(v) && v.every((x) => typeof x === "string")) {
          out[k] = v.map((t) => tagMap.get(t) || t);
        } else if (k === "operationId" && typeof v === "string") {
          out[k] = unique(usedOpIds, `${opIdPrefix}_${v}`);
        } else {
          out[k] = cloneAndRewrite(v as any, refMap, tagMap, opIdPrefix, basePath);
        }
      }
      return out;
    };

    for (let i = 0; i < schemas.length; i++) {
      const schema: any = schemas[i] || {};
      const sourcePath = this.schemaManySources[i] || `multi://input/${i + 1}`;
      const prefix = baseName(sourcePath);

      // Track prefix for this source path (strip hash). Only map real file/http paths
      const withoutHash = url.stripHash(sourcePath);
      const protocol = url.getProtocol(withoutHash);
      if (protocol === undefined || protocol === "file" || protocol === "http" || protocol === "https") {
        this.sourcePathToPrefix.set(withoutHash, prefix);
      }

      const refMap = new Map<string, string>();
      const tagMap = new Map<string, string>();

      const srcComponents = (schema.components || {}) as any;
      for (const sec of componentSections) {
        const group = srcComponents[sec] || {};
        for (const [name] of Object.entries(group)) {
          const newName = `${prefix}_${name}`;
          refMap.set(`#/components/${sec}/${name}`, `#/components/${sec}/${newName}`);
        }
      }

      const srcTags: any[] = Array.isArray(schema.tags) ? schema.tags : [];
      for (const t of srcTags) {
        if (!t || typeof t !== "object" || typeof t.name !== "string") {
          continue;
        }
        const desired = t.name;
        const finalName = tagNameSet.has(desired) ? `${prefix}_${desired}` : desired;
        tagNameSet.add(finalName);
        tagMap.set(desired, finalName);
        if (!tags.find((x) => x && x.name === finalName)) {
          tags.push({ ...t, name: finalName });
        }
      }

      for (const sec of componentSections) {
        const group = (schema.components && schema.components[sec]) || {};
        for (const [name, val] of Object.entries(group)) {
          const newName = `${prefix}_${name}`;
          merged.components[sec][newName] = cloneAndRewrite(val, refMap, tagMap, prefix, url.stripHash(sourcePath));
        }
      }

      const srcPaths = (schema.paths || {}) as Record<string, any>;
      for (const [p, item] of Object.entries(srcPaths)) {
        let targetPath = p;
        if (merged.paths[p]) {
          const trimmed = p.startsWith("/") ? p.substring(1) : p;
          targetPath = `/${prefix}/${trimmed}`;
        }
        merged.paths[targetPath] = cloneAndRewrite(item, refMap, tagMap, prefix, url.stripHash(sourcePath));
      }
    }

    if (tags.length > 0) {
      merged.tags = tags;
    }

    // Rebuild $refs root using the first input's path to preserve external resolution semantics
    const rootPath = this.schemaManySources[0] || url.cwd();
    this.$refs = new $Refs();
    const rootRef = this.$refs._add(rootPath);
    rootRef.pathType = url.isFileSystemPath(rootPath) ? "file" : "http";
    rootRef.value = merged;
    this.schema = merged;
    return merged as JSONSchema;
  }
}

export { sendRequest } from "./resolvers/url.js";
export type { JSONSchema } from "./types/index.js";
