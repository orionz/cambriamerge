
## Cambria Automerge

Cambria Automerge is a proof of concept implementation of
[cambria](https://github.com/inkandswitch/cambria) on
[automerge](https://github.com/automerge/automerge/).

This represents an alternate implementation of the Automerge 0.14 backend with
just enough functionality to be tested against an experimental branch of
[hypermerge](https://github.com/orionz/hypermerge/tree/cambria).

This implementation should NOT be used in any kind of production environment
and is just a proof of concept.

### How it works

The frontend backend connection have a single cambria schema between
them - this allows an unmodified automerge frontend to interface with the
cambria backend since they always speak the same change-request/patch language.
A more advanced implementation might allow the frontend to shift between
schemas and validate that all changes are legal to the schema before sending
them to the backend.

The backend wraps changes and tracks the schema ID.  Before each change can be
applied the change (and its ops) are migrated to the intended schema using cambria.
The pipeline looks something like this

```ts
  function convertOp(...) : Op[] {

    const patch = opToPatch(op, from)
    const convertedPatch = applyLensToPatch(lensStack, patch, jsonschema7)
    const convertedOps = patchToOps(convertedPatch, to)

    return convertedOps
  }
```

The op is transformed into a patch, the patch is converted via cambria, then
converted back into an op and applied.

The patch conversion requires mapping between objectId's and elementId's in
automerge to json paths which in the current nieve implementation is done by
managing multiple automerge backends and doing lookups for each op.  This
process is obviously slow and non-optimal but optimized implementations are
possible.

### Technical details

The default values of an empty dock need to be populated before the first
change is applied.  This is done by each document generating a "phantom change"
with actorId '0000000000' seq 1 which the first commit depends on.  This
dependency is not leaked to the outside world as we don't want it written to
disk or sent out over the network. As long as cambria generates the same list
of default patches for all peers they will have an identical phantom default
change. The default patch is generated by trying to apply the `urOp` that is 
implied by automerges root map's existence and applying the cambria lenses to
it.

```
  { op: 'add' as const, path: '', value: {} }
```

When a migration creates an insert (and an elemid) the system increments the
last seen highest elemid for that actor as if that actor had created is.  As
each actors changes have a distinct order this means that everyone will see the
same elemids per actor per schema.  This does mean there will be duplicate
elemids within a document breaking an automerge assumption BUT they will never
be in the same sequence therefore it should not cause any problems in practice.

### Why automerge 0.14 instead of 1.0

We attempted to do this integration with automerge 1.0 (performance branch) but
found it's optimizations frustrated our attempts to do this integration.

The binary format required encoding and decoding, hash's and deps were unstable
due to generated changes, opId's and startOp were unstable due to one op
sometimes being translated into many.

