import { Graph, alg } from "graphlib";
import * as Backend from "automerge/backend";
import { Op, Clock, Change } from "automerge";
import { encodeChange, decodeChange } from "automerge";
import { JSONSchema7 } from "json-schema";
import {
  Patch,
  LensSource,
  LensOp,
  updateSchema,
  reverseLens,
  applyLensToPatch,
} from "cloudina";
import * as Automerge from "automerge";
import { inspect } from "util";

// applyPatch PATCH needs to become - buildChange
// buildChange needs to incrementally track op state re 'make' - list 'insert' 'del'
// need to track deps/clock differently at the top level than at the instance level
// seq will be different b/c of lenses

const ROOT_ID = "00000000-0000-0000-0000-000000000000";
export const CAMBRIA_MAGIC_ACTOR = "0000000000";

function deepInspect(object: any) {
  return inspect(object, false, null, true);
}

const emptySchema = {
  $schema: "http://json-schema.org/draft-07/schema",
  type: "object" as const,
  additionalProperties: false,
};

type Hash = string;

export interface Instance {
  //clock : Clock,
  schema: string;
  deps: Hash[];
  seq: number;
  startOp: number;
  doc: Backend.BackendState;
}

export type CambriaBlock = AutomergeChange | RegisteredLens;

export interface RegisteredLens {
  kind: "lens";
  to: string;
  from: string;
  lens: LensSource;
}

export interface AutomergeChange {
  kind: "change";
  schema: string;
  change: Change;
}

export type InitOptions = {
  actorId?: string;
  schema?: string;
  deferActorId?: boolean;
  freeze?: boolean;
};

export function init(options: InitOptions = {}): CambriaState {
  return new CambriaState(options.schema || "mu");
}

export function registerLens(
  doc: CambriaState,
  from: string,
  to: string,
  lenses: LensSource
): CambriaState {
  doc.registerLens(from, to, lenses);
  return doc;
}

export function applyChanges(
  doc: CambriaState,
  changes: CambriaBlock[]
): [CambriaState, Backend.Patch] {
  const patch = doc.applyChanges(changes);
  return [doc, patch];
}

export function applyLocalChange(
  doc: CambriaState,
  request: Backend.Request
): [CambriaState, Patch] {
  let patch = doc.applyLocalChange(request);
  return [doc, patch];
}

export function getChanges(
  doc: CambriaState,
  haveDeps: Hash[]
): CambriaBlock[] {
  return doc.getChanges(haveDeps);
}

/*
export function encodeChange(change: automerge.Change): Change {
}

export function decodeChange(binaryChange: Change): automerge.Change {
}
*/

export class CambriaState {
  schema: string;
  //deps: Hash[]
  //clock: Clock
  history: CambriaBlock[];
  //seq: number
  //maxOp: number
  private instances: { [schema: string]: Instance };
  private graph: Graph;
  private jsonschema7: { [schema: string]: JSONSchema7 };

  constructor(schema: string) {
    this.schema = schema;
    this.history = [];
    this.instances = {};
    //this.seq = 0
    //this.maxOp = 0
    //this.deps = []
    //this.clock = {}
    this.graph = new Graph();
    this.jsonschema7 = { mu: emptySchema };
    this.graph.setNode("mu", true);
  }

  applyLocalChange(request: Backend.Request): Backend.Patch {
    const instance = this.instances[this.schema];

    if (instance === undefined) {
      throw new RangeError(
        `cant apply change - no instance for '${this.schema}'`
      );
    }

    const oldDeps = instance.deps;

    const [doc, patch] = Backend.applyLocalChange(instance.doc, request);

    const changes = Backend.getChanges(doc, oldDeps);

    if (changes.length !== 1) {
      throw new RangeError(
        `apply local changes produced invalid (${changes.length}) changes`
      );
    }

    const change: Change = decodeChange(changes[0]);
    const block: AutomergeChange = {
      kind: "change",
      schema: this.schema,
      change,
      // FIXME hash // deps // actor
    };

    this.history.push(block);
    this.applySchemaChanges([block], this.schemas);

    return patch;
  }

  reset() {
    this.instances = {};
  }

  addLens(from: string, to: string, lenses: LensSource) {
    // turn this into a change - make sure it gets fed back into the network like applyLocalChange in hypermerge
    if (!this.graph.node(from)) {
      throw new RangeError(`unknown schema ${from}`);
    }

    if (this.graph.node(to)) {
      throw new RangeError(`already have a schema named ${to}`);
    }

    // if there's already a lens between two schemas, don't add this new one
    // if (this.graph.edge({ v: lens.source, w: lens.destination })) return

    this.graph.setNode(to, true);
    this.graph.setEdge(from, to, lenses);
    this.graph.setEdge(to, from, reverseLens(lenses));

    this.jsonschema7[to] = updateSchema(this.jsonschema7[from], lenses);
  }

  registerLens(from: string, to: string, lenses: LensSource) {
    this.addLens(from, to, lenses);

    // FIXME - also write to history - update deps

    this.reset();
    this.applySchemaChanges(this.history, this.schemas);
  }

  // take a change and apply it everywhere
  // take a change and apply it everywhere except one place
  // take all changes and apply them in one place

  applyChanges(blocks: CambriaBlock[]): Backend.Patch {
    this.history.push(...blocks);
    return this.applySchemaChanges(blocks, this.schemas);
  }

  getChanges(haveDeps: Hash[]): CambriaBlock[] {
    // FIXME - todo
    return [];
  }

  schemasEndingIn(schema: string): string[] {
    return this.schemas
      .filter((n) => n !== "mu")
      .sort((a, b) => (a === schema ? 1 : -1));
  }

  applySchemaChanges(blocks: CambriaBlock[], schemas: string[]): Backend.Patch {
    const instanceCache = {};
    const opCache = {};
    const changeCache = {};

    for (let schema of schemas) {
      instanceCache[schema] = { ...this.getInstance(schema) };
      opCache[schema] = [];
      changeCache[schema] = [];
    }

    // run the ops through one at a time to apply the change
    // we're throwing all this away and will start over below
    // I can probably replace this by lifting the LocalChange code from automerge

    for (let block of blocks) {
      if (block.kind === "lens") {
        this.addLens(block.from, block.to, block.lens);
        continue;
      }

      for (let i in block.change.ops) {
        const op = block.change.ops[i];
        for (let schema of schemas) {
          const from = instanceCache[block.schema];
          const to = instanceCache[schema];
          const convertedOps = this.convertOp(op, from, to);
          const deps = to.deps; // FIXME - need to actually translate the deps
          const microChange = {
            actor: block.change.actor,
            message: block.change.message,
            deps,
            seq: to.seq,
            startOp: to.startOp,
            ops: convertedOps,
          };
          opCache[schema].push(...convertedOps);
          const binMicroChange = encodeChange(microChange);
          const [newDoc, patch] = Backend.applyChanges(to.doc, [
            binMicroChange,
          ]);
          to.doc = newDoc;
          to.seq += 1;
          to.startOp += 1;
          to.deps = patch.deps;
        }
      }

      for (let schema of schemas) {
        const instance = this.getInstance(block.schema);
        const doc = instance.doc;
        const ops = opCache[schema];
        const deps = instance.deps;
        instance.seq += 1;
        const change = {
          actor: block.change.actor,
          message: block.change.message,
          deps,
          seq: instance.seq,
          startOp: instance.startOp,
          ops,
        };
        const binChange = encodeChange(change);
        changeCache[schema].push(binChange);
        opCache[schema] = [];
      }
    }

    // rewind and apply the ops all at once - get the patch

    let finalPatch;

    for (let schema of schemas) {
      const instance = this.getInstance(schema);
      const [newDoc, patch] = Backend.applyChanges(
        instance.doc,
        changeCache[schema]
      );
      // FIXME - startOp / seq
      instance.doc = newDoc;
      instance.deps = patch.deps;
      if (schema === this.schema) {
        finalPatch = patch;
      }
    }

    if (finalPatch === undefined) {
      finalPatch = Backend.getPatch(this.getInstance(this.schema).doc);
    }

    return finalPatch;
  }

  convertOp(op: Op, from: Instance, to: Instance): Op[] {
    // FIXME
    return [];
  }

  /*
  applyChange2(change: Change) {
    this.history.push(change)
    //this.clock[change.actor] = change.seq
    //this.maxOp = Math.max(this.maxOp, change.startOp + change.ops.length - 1)
    //this.deps = calcDeps(change, this.deps)

    for (const index in change.ops) {
      if (change.ops[index]) {
        const op = change.ops[index]
        op.opId = `${change.startOp + index}@${change.actor}`
        this.schemas
          // sort schemas so that op.schema is run last ... FIXME
          .forEach((schema) => {
            this.lensOpToSchemaAndApply(op, schema)
          })
      }
    }
  }

  private lensOpToSchemaAndApply(op: Op, schema: string) {
    const fromInstance = this.getInstance(op.schema || 'mu')
    const toInstance = this.getInstance(schema)

    const lenses = this.lensesFromTo(op.schema || 'mu', schema)
    const patch = opToPatch(op, fromInstance)
    const jsonschema7 = this.jsonschema7[op.schema || "mu"]
    const newpatch = applyLensToPatch(lenses, patch, jsonschema7)
    applyPatch(toInstance, newpatch, op.opId as string)
  }
*/

  private getInstance(schema: string): Backend.BackendState {
    if (!this.instances[schema]) {
      const doc = new Backend.init();
      const instance = { doc, seq: 1, deps: [], startOp: 1, schema };
      this.bootstrap(instance, schema);
      this.instances[schema] = instance;
    }
    return this.instances[schema];
  }

  private bootstrap(instance: Backend.BackendState, schema: string) {
    const urOp = [{ op: "add" as const, path: "", value: {} }];
    const jsonschema7 = this.jsonschema7[schema];
    const defaultsPatch = applyLensToPatch([], urOp, jsonschema7).slice(1);
    const bootstrapChange = buildBootstrapChange(
      CAMBRIA_MAGIC_ACTOR,
      defaultsPatch
    );
    const [newDoc, patch] = Backend.applyChanges(instance.doc, [
      encodeChange(bootstrapChange),
    ]);
    instance.doc = newDoc;
  }

  get schemas(): string[] {
    return this.graph.nodes();
  }

  private lensesFromTo(from: string, to: string): LensSource {
    const migrationPaths = alg.dijkstra(this.graph, to);
    const lenses: LensOp[] = [];
    if (migrationPaths[from].distance == Infinity) {
      console.log("infinity... error?");
      return []; // error?
    }
    if (migrationPaths[from].distance == 0) {
      return [];
    }
    for (let v = from; v != to; v = migrationPaths[v].predecessor) {
      const w = migrationPaths[v].predecessor;
      const edge = this.graph.edge({ v, w });
      lenses.push(...edge);
    }
    return lenses;
  }
}

function buildBootstrapChange(actor: string, patch: Patch): Backend.Change {
  const opCache = {};
  const pathToOpId = { [""]: ROOT_ID };
  const ops = patch.map((patchop, i) => {
    let action;
    if (patchop.op === "remove") {
      action = "del";
    } else if (patchop.op === "add" || patchop.op === "replace") {
      if (
        patchop.value === null ||
        ["string", "number", "boolean"].includes(typeof patchop.value)
      ) {
        action = "set";
      } else if (Array.isArray(patchop.value)) {
        action = "makeList";
      } else if (
        typeof patchop.value === "object" &&
        Object.keys(patchop.value).length === 0
      ) {
        action = "makeMap";
      } else {
        throw new RangeError(`bad value for patchop=${deepInspect(patchop)}`);
      }
    } else {
      throw new RangeError(`bad op type for patchop=${deepInspect(patchop)}`);
    }
    const opId = `${1 + i}@${actor}`;
    if (action.startsWith("make")) {
      pathToOpId[patchop.path] = opId;
    }
    const regex = /^(.*)\/([^/]*$)/;
    // /foo -> "" "foo"
    // /foo/bar -> "/foo" "bar"
    // /foo/bar/baz -> "/foo/bar" "baz"

    const match = regex.exec(patchop.path);
    if (!match) {
      throw new RangeError(`bad path in patchop ${deepInspect(patchop)}`);
    }
    const obj_path = match[1];
    const key = match[2];
    const obj = pathToOpId[obj_path];
    if (!obj) {
      throw new RangeError(
        `failed to look up obj_id for path ${deepInspect(
          patchop
        )} :: ${deepInspect(pathToOpId)}`
      );
    }

    //const path = patchop.path.split('/').slice(1)
    //const { obj, key } = instance.processPath(path, patchop.op === 'add')
    const insert =
      patchop.op === "add" &&
      obj !== ROOT_ID &&
      opCache[obj].action === "makeList";
    if (patchop.op === "add" || patchop.op === "replace") {
      const op = { action, obj, key, insert, value: patchop.value, pred: [] };
      opCache[opId] = op;
      return op;
    } else {
      const op = { action, obj, key, insert, pred: [] };
      opCache[opId] = op;
      return op;
    }
  });
  const op = {
    actor,
    message: "",
    deps: [],
    seq: 1,
    startOp: 1,
    time: 0,
    ops,
  };
  return op;
}

function applyPatch(
  instance: Backend.BackendState,
  patch: Patch,
  incomingOpId: string
): Op[] {
  let { counter, actor } = parseOpId(incomingOpId);
  return patch.map((patchop) => {
    let action;
    if (patchop.op === "remove") {
      action = "del";
    } else if (patchop.op === "add" || patchop.op === "replace") {
      if (
        patchop.value === null ||
        ["string", "number", "boolean"].includes(typeof patchop.value)
      ) {
        action = "set";
      } else if (Array.isArray(patchop.value)) {
        action = "makeList";
      } else if (
        typeof patchop.value === "object" &&
        Object.keys(patchop.value).length === 0
      ) {
        action = "makeMap";
      } else {
        throw new RangeError(`bad value for patchop=${deepInspect(patchop)}`);
      }
    } else {
      throw new RangeError(`bad op type for patchop=${deepInspect(patchop)}`);
    }
    const path = patchop.path.split("/").slice(1);
    const { obj, key } = instance.processPath(path, patchop.op === "add");
    const insert = patchop.op === "add" && Array.isArray(instance.byObjId[obj]);
    const opId = `${counter}@${actor}`;
    counter += 0.1;
    if (patchop.op === "add" || patchop.op === "replace") {
      const op = { opId, action, obj, key, insert, value: patchop.value };
      instance.applyOp(op); // side effect!!!
      return op;
    } else {
      const op = { opId, action, obj, key, insert };
      instance.applyOp(op); // side effect!!!
      return op;
    }
  });
}

function parseOpId(opid: string): { counter: number; actor: string } {
  const regex = /^([0-9.]+)@(.*)$/;
  const match = regex.exec(opid);
  if (match == null) {
    throw new RangeError(`Invalid OpId ${opid}`);
  }
  const counter = parseFloat(match[1]);
  const actor = match[2];
  return { counter, actor };
}

function setAction(op: Op, instance: Backend.BackendState): "add" | "replace" {
  if (Array.isArray(instance.byObjId[op.obj])) {
    return op.insert ? "add" : "replace";
  }
  return instance.metadata[op.obj][op.key] ? "replace" : "add";
}

export function opToPatch(op: Op, instance: Backend.BackendState): Patch {
  switch (op.action) {
    case "set": {
      const path = buildPath(op, instance);
      const { value } = op;
      const action = setAction(op, instance);
      return [{ op: action, path, value }];
    }
    case "del": {
      const path = buildPath(op, instance);
      return [{ op: "remove", path }];
    }
    default:
      throw new RangeError(`unsupported op ${deepInspect(op)}`);
  }
}

function buildPath(op: Op, instance: Backend.BackendState): string {
  let { obj } = op;
  let { key } = op;
  const path: (string | number)[] = [];
  while (obj !== ROOT_ID) {
    if (Array.isArray(instance.byObjId[op.obj])) {
      const { visible } = instance.findListElement(op.obj, op.key);
      path.push(visible);
    } else {
      path.push(key);
    }
    ({ key, obj } = instance.ops[obj]);
  }
  path.push(key);
  path.reverse();
  return `/${path.join("/")}`;
}

function calcDeps(change: Change, deps: Clock): Clock {
  const newDeps = {};
  for (const actor in deps) {
    if (deps[actor] > (change.deps[actor] || 0)) {
      newDeps[actor] = deps[actor];
    }
  }
  newDeps[change.actor] = change.seq;
  return newDeps;
}