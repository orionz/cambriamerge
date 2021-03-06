import assert from 'assert'
import { inspect } from 'util'
import { addProperty, renameProperty, LensSource } from 'cambria'
import { Frontend } from 'automerge'
import { inside, plungeProperty, removeProperty, wrapProperty, hoistProperty, map } from 'cambria'
import * as Cambria from '../src/index'
import { mkBlock } from '../src/cambriamerge'

const ACTOR_ID_1 = '111111'
const ACTOR_ID_2 = '222222'

const InitialProjectLens: LensSource = [
  addProperty({ name: 'name', type: 'string' }),
  addProperty({ name: 'summary', type: 'string' }),
]

const FillOutProjectLens: LensSource = [
  addProperty({ name: 'created_at', type: 'string' }),
  addProperty({ name: 'details', type: 'object' }),
  inside('details', [
    addProperty({ name: 'author', type: 'string' }),
    addProperty({ name: 'date', type: 'string' }),
  ]),
]

const RenameLens: LensSource = [renameProperty('name', 'title')]
const PlungeIntoDetailsLens: LensSource = [plungeProperty('details', 'created_at')]
const RenameNestedLens: LensSource = [inside('details', [renameProperty('date', 'updated_at')])]

// use these to just get a stack of all the lenses we have
const AllLenses: LensSource[] = [
  InitialProjectLens,
  FillOutProjectLens,
  RenameLens,
  PlungeIntoDetailsLens,
  RenameNestedLens,
]

const AllLensChanges: Cambria.RegisteredLens[] = AllLenses.map((current, currentIndex) => ({
  from: currentIndex === 0 ? 'mu' : `project-v${currentIndex}`,
  to: `project-v${currentIndex + 1}`,
  lens: current,
}))
const LAST_SCHEMA = AllLensChanges[AllLensChanges.length - 1].to

// Use these when you need less
const InitialLensChange = {
  from: 'mu',
  to: 'project-v1',
  lens: InitialProjectLens,
}

const FillOutProjectLensChange = {
  from: 'project-v1',
  to: 'project-filled-out',
  lens: FillOutProjectLens,
}

const RenameLensChange = {
  from: 'project-v1',
  to: 'project-rename',
  lens: RenameLens,
}

// eslint-disable-next-line
function deepInspect(object: any) {
  return inspect(object, false, null, true)
}

const [v1Cambria, v1InitialPatch] = Cambria.applyChanges(
  Cambria.init({ schema: 'project-v1', lenses: [InitialLensChange] }),
  []
)
const v1Frontend = Frontend.applyPatch(Frontend.init(ACTOR_ID_1), v1InitialPatch)

describe('Has basic schema tools', () => {
  it('can accept a single schema and fill out default values', () => {
    assert.deepEqual(v1InitialPatch.diffs, [
      {
        action: 'set',
        key: 'name',
        obj: '00000000-0000-0000-0000-000000000000',
        path: [],
        type: 'map',
        value: '',
      },
      {
        action: 'set',
        key: 'summary',
        obj: '00000000-0000-0000-0000-000000000000',
        path: [],
        type: 'map',
        value: '',
      },
    ])
  })

  it('throws an error if invalid lens is given', () => {
    assert.throws(() => Cambria.init({ schema: 'invalid', lenses: [] }))
  })

  it('can accept a real change', () => {
    const [, change] = Frontend.change(v1Frontend, (doc: any) => {
      doc.title = 'hello'
    })
    const cambriaChange = mkBlock({
      schema: 'project-v1',
      change,
    })
    const [, patch] = Cambria.applyChanges(v1Cambria, [cambriaChange])

    assert.deepEqual(patch.diffs, [
      {
        action: 'set',
        key: 'title',
        obj: '00000000-0000-0000-0000-000000000000',
        path: [],
        type: 'map',
        value: 'hello',
      },
    ])
  })

  // XXX: i'm testing... something here. it's not really clear to me why, though.
  it('can accept a real change with its lens', () => {
    const cambria = Cambria.init({
      schema: 'project-rename',
      lenses: [InitialLensChange, RenameLensChange],
    })

    // this is cheating... i know the property will be called title post-lens application
    const v2Frontend = v1Frontend
    const [, change] = Frontend.change(v2Frontend, (doc: any) => {
      doc.title = 'hello'
    })

    //    const cambriaChange = mkBlock({ schema: 'project-rename', change })
    const [, patch2] = Cambria.applyLocalChange(cambria, change)
    //    const [, patch2] = Cambria.applyChanges(cambria, [cambriaChange])

    assert.deepEqual(patch2.diffs, [
      {
        action: 'set',
        key: 'title',
        obj: '00000000-0000-0000-0000-000000000000',
        path: [],
        type: 'map',
        value: '',
      },
      {
        action: 'set',
        key: 'summary',
        obj: '00000000-0000-0000-0000-000000000000',
        path: [],
        type: 'map',
        value: '',
      },
      {
        action: 'set',
        key: 'title',
        obj: '00000000-0000-0000-0000-000000000000',
        path: [],
        type: 'map',
        value: 'hello',
      },
    ])
  })

  it('converts a doc from v1 to v2', () => {
    const [, change] = Frontend.change(v1Frontend, (doc: any) => {
      doc.name = 'hello'
    })
    const cambriaChange = mkBlock({ schema: 'project-v1', change })

    const [cambria] = Cambria.applyChanges(
      Cambria.init({ schema: LAST_SCHEMA, lenses: [...AllLensChanges, RenameLensChange] }),
      []
    )

    const [finalDoc] = Cambria.applyChanges(cambria, [cambriaChange])

    const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
    assert.deepEqual(frontend, {
      title: 'hello',
      summary: '',
      details: {
        author: '',
        created_at: '',
        updated_at: '',
      },
    })
  })

  it('can handle writes from two actors on different schemas', () => {
    const state1 = Cambria.init({
      schema: 'project-v1',
      lenses: AllLensChanges,
    })

    // Make a change in a V1 frontend
    const [, nameChange] = Frontend.change(v1Frontend, (doc: any) => {
      doc.name = 'hello'
    })

    // Init a V2 frontend and use it to make a change
    const [v2Cambria, v2InitialPatch] = Cambria.applyChanges(
      Cambria.init({ schema: 'project-v2', lenses: AllLensChanges }),
      []
    )
    const v2Frontend = Frontend.applyPatch(Frontend.init(ACTOR_ID_2), v2InitialPatch)

    const [, filloutChange] = Frontend.change(v2Frontend, (doc: any) => {
      // set a map directly, creating a new object and a makeMap op
      // (this is missing a field that v2 actually requires)
      doc.details = { author: 'Peter' }
    })

    const changeBlocks = [
      mkBlock({ schema: 'project-v1', change: nameChange }),
      mkBlock({ schema: 'project-v2', change: filloutChange }),
    ]

    // Play the changes into a v1 frontend
    const [finalV1State] = Cambria.applyChanges(state1, changeBlocks)
    const finalV1Doc = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalV1State))
    assert.deepEqual(finalV1Doc, { name: 'hello', summary: '' })

    // Play the changes into a V3 frontend.
    // This forces the v2 change to get lensed, filling in default values
    const state3 = Cambria.init({
      schema: 'project-v3',
      lenses: AllLensChanges,
    })
    const [finalV3State] = Cambria.applyChanges(state3, changeBlocks)
    const finalV3Doc = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalV3State))
    assert.deepEqual(finalV3Doc, {
      title: 'hello',
      summary: '',
      created_at: '',
      details: {
        author: 'Peter',
        date: '',
      },
    })
  })

  it('can handle writes from v1 and v2 when lenses are in memory, not in doc', () => {
    const state1 = Cambria.init({
      schema: 'project-v5',
      lenses: AllLensChanges,
    })

    const [frontEnd, nameChange] = Frontend.change(v1Frontend, (doc: any) => {
      doc.name = 'hello'
    })
    const [, filloutChange] = Frontend.change(frontEnd, (doc: any) => {
      doc.details = {}
      doc.details.author = 'Peter'
    })

    const [finalDoc] = Cambria.applyChanges(state1, [
      mkBlock({ schema: InitialLensChange.to, change: nameChange }),
      mkBlock({ schema: AllLensChanges.slice(-1)[0].to, change: filloutChange }),
    ])

    const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
    assert.deepEqual(frontend, {
      title: 'hello',
      summary: '',
      details: { author: 'Peter' },
    })
  })

  it.skip('can convert data when necessary lens comes after the write', () => {
    // Intent of this test is to exercise the case where lenses aren't registered
    // upfront; a lens later in the op log needs to be used for a conversion earlier
    // in the op log.
    // We're deferring this test because depending on how we do lens registration
    // this may not really be necessary functionality
    const state1 = Cambria.init({
      schema: 'project-filled-out',
      lenses: [InitialLensChange, FillOutProjectLensChange],
    })

    const [, nameChange] = Frontend.change(v1Frontend, (doc: any) => {
      doc.name = 'hello'
    })
    const [, filloutChange] = Frontend.change(v1Frontend, (doc: any) => {
      doc.details = {}
      doc.details.author = 'Peter'
    })

    const [finalDoc] = Cambria.applyChanges(state1, [
      mkBlock({ schema: InitialLensChange.to, change: nameChange }),
      mkBlock({
        schema: FillOutProjectLensChange.to,
        lenses: [FillOutProjectLensChange],
        change: filloutChange,
      }),
    ])

    const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
    assert.deepEqual(frontend, {
      name: 'actor 2 says hi',
      summary: '',
    })
  })

  describe('removeProperty lens', () => {
    const RemoveLens: LensSource = [removeProperty({ name: 'name', type: 'string' })]
    const RemoveLensChange = {
      from: 'project-v1',
      to: 'project-remove',
      lens: RemoveLens,
    }
    it('can convert with a removeProperty lens', () => {
      const removeCambria = Cambria.init({
        schema: RemoveLensChange.to,
        lenses: [InitialLensChange, RemoveLensChange],
      })

      // V1 writes to the title property, which should become a no-op
      const [, nameChange] = Frontend.change(v1Frontend, (doc: any) => {
        doc.name = 'hello'
      })
      const [finalDoc] = Cambria.applyChanges(removeCambria, [
        mkBlock({ schema: InitialLensChange.to, change: nameChange }),
      ])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
      assert.deepEqual(frontend, {
        summary: '',
      })
    })
  })

  describe('nested objects', () => {
    it('can accept a single schema and fill out default values', () => {
      const [, initialPatch] = Cambria.applyChanges(
        Cambria.init({ schema: LAST_SCHEMA, lenses: AllLensChanges }),
        []
      )

      const frontend = Frontend.applyPatch(Frontend.init(ACTOR_ID_1), initialPatch)
      assert.deepEqual(frontend, {
        summary: '',
        title: '',
        details: {
          author: '',
          created_at: '',
          updated_at: '',
        },
      })
    })

    it('can accept a real change', () => {
      const [cambria] = Cambria.applyChanges(
        Cambria.init({ schema: LAST_SCHEMA, lenses: AllLensChanges }),
        []
      )

      const [, filledOutInitialPatch] = Cambria.applyChanges(
        Cambria.init({ schema: 'project-v2', lenses: AllLensChanges }),
        []
      )
      const filledOutFrontend = Frontend.applyPatch(
        Frontend.init(ACTOR_ID_1),
        filledOutInitialPatch
      )

      const [, change] = Frontend.change(filledOutFrontend, (doc: any) => {
        doc.details.author = 'Klaus'
      })

      // wrap that change in Cambria details
      const [finalDoc] = Cambria.applyChanges(cambria, [
        mkBlock({
          schema: 'project-v2',
          change,
        }),
      ])

      // confirm the resulting patch is correct!
      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
      assert.deepEqual(frontend, {
        details: {
          author: 'Klaus',
          created_at: '',
          updated_at: '',
        },
        summary: '',
        title: '',
      })
    })

    it('can apply a change from another V2', () => {
      // Create an old v2 format patch
      const [, v2InitialPatch] = Cambria.applyChanges(
        Cambria.init({ schema: 'project-v2', lenses: AllLensChanges }),
        []
      )
      const v2Frontend = Frontend.applyPatch(Frontend.init(ACTOR_ID_1), v2InitialPatch)
      // Apply a V2 change to a full-fledged backend and read it successfully
      const [, change] = Frontend.change(v2Frontend, (doc: any) => {
        doc.details.author = 'R. van Winkel'
      })

      // make a new modern Cambria and apply the patch
      const [cambria] = Cambria.applyChanges(
        Cambria.init({ schema: LAST_SCHEMA, lenses: AllLensChanges }),
        []
      )

      const [finalDoc] = Cambria.applyChanges(cambria, [
        mkBlock({
          schema: 'project-v2',
          change,
        }),
      ])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
      assert.deepEqual(frontend, {
        title: '',
        summary: '',
        details: {
          author: 'R. van Winkel',
          created_at: '',
          updated_at: '',
        },
      })
    })

    it('can convert a rename inside an object', () => {
      const [cambria] = Cambria.applyChanges(
        Cambria.init({ schema: LAST_SCHEMA, lenses: AllLensChanges }),
        []
      )

      const [, v2InitialPatch] = Cambria.applyChanges(
        Cambria.init({ schema: 'project-v2', lenses: AllLensChanges }),
        []
      )
      const v2Frontend = Frontend.applyPatch(Frontend.init(ACTOR_ID_2), v2InitialPatch)
      // Apply a V2 change to a full-fledged backend and read it successfully
      const [, change] = Frontend.change(v2Frontend, (doc: any) => {
        doc.details.date = 'long long ago'
      })

      const [finalDoc] = Cambria.applyChanges(cambria, [
        mkBlock({
          schema: 'project-v2',
          change,
        }),
      ])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
      assert.deepEqual(frontend, {
        title: '',
        summary: '',
        details: {
          author: '',
          updated_at: 'long long ago',
          created_at: '',
        },
      })
    })

    it('can plunge a property', () => {
      const PlungeLensChange = {
        from: 'project-filled-out',
        to: 'project-plunged',
        lens: PlungeIntoDetailsLens,
      }

      const LensChanges = [InitialLensChange, FillOutProjectLensChange, PlungeLensChange]

      const [cambria] = Cambria.applyChanges(
        Cambria.init({ schema: 'project-plunged', lenses: LensChanges }),
        []
      )

      const [, v2InitialPatch] = Cambria.applyChanges(
        Cambria.init({ schema: 'project-filled-out', lenses: LensChanges }),
        []
      )
      const v2Frontend = Frontend.applyPatch(Frontend.init(ACTOR_ID_1), v2InitialPatch)

      // Apply a V2 change to a full-fledged backend and read it successfully
      const [, change] = Frontend.change(v2Frontend, (doc: any) => {
        doc.created_at = 'recently'
      })

      const [finalDoc] = Cambria.applyChanges(cambria, [
        mkBlock({
          schema: 'project-filled-out',
          change,
        }),
      ])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
      assert.deepEqual(frontend, {
        name: '',
        summary: '',
        details: {
          author: '',
          date: '',
          created_at: 'recently',
        },
      })
    })

    it('can hoist a property', () => {
      const HoistLens = [hoistProperty('details', 'author')]
      const HoistLensChange = {
        from: 'project-filled-out',
        to: 'project-hoisted',
        lens: HoistLens,
      }

      const LensChanges = [InitialLensChange, FillOutProjectLensChange, HoistLensChange]

      const [cambria] = Cambria.applyChanges(
        Cambria.init({ schema: 'project-hoisted', lenses: LensChanges }),
        []
      )

      const [, v2InitialPatch] = Cambria.applyChanges(
        Cambria.init({ schema: 'project-filled-out', lenses: LensChanges }),
        []
      )
      const v2Frontend = Frontend.applyPatch(Frontend.init(ACTOR_ID_1), v2InitialPatch)

      // Apply a V2 change to a full-fledged backend and read it successfully
      const [, change] = Frontend.change(v2Frontend, (doc: any) => {
        doc.details.author = 'Steven King'
      })

      const [finalCambria] = Cambria.applyChanges(cambria, [
        mkBlock({
          schema: 'project-filled-out',
          change,
        }),
      ])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalCambria))
      assert.deepEqual(frontend, {
        name: '',
        summary: '',
        author: 'Steven King',
        created_at: '',
        details: {
          date: '',
        },
      })
    })

    it('can hoist a property from 2 levels deep', () => {
      const deepNestingLensChange = {
        from: 'mu',
        to: 'nested-v1',
        lens: [
          addProperty({ name: 'branch1', type: 'object' }),
          inside('branch1', [
            addProperty({ name: 'branch2', type: 'object' }),
            inside('branch2', [
              addProperty({ name: 'leaf1', type: 'string' }),
              addProperty({ name: 'leaf2', type: 'string' }),
            ]),
          ]),
        ],
      }

      const hoistLensChange = {
        from: 'nested-v1',
        to: 'nested-v2',
        lens: [inside('branch1', [hoistProperty('branch2', 'leaf1')])],
      }

      const cambria = Cambria.init({
        schema: 'nested-v2',
        lenses: [deepNestingLensChange, hoistLensChange],
      })

      // fill in default values by applying an empty change
      // (todo: reconsider this workflow)
      const [, patch2] = Cambria.applyChanges(cambria, [])

      // get the generated obj ID for the branch2 map from the default values,
      // to use in the change below
      const branch2ObjId = patch2.diffs.find(
        (d) =>
          d.action === 'set' &&
          d.path?.length === 1 &&
          d.path[0] === 'branch1' &&
          d.key === 'branch2' &&
          d.link
      )

      if (!branch2ObjId) throw new Error('expected to find objID for branch2 map')

      const [finalDoc] = Cambria.applyChanges(cambria, [
        mkBlock({
          schema: 'nested-v1',
          change: {
            message: '',
            actor: ACTOR_ID_1,
            seq: 1,
            deps: { '0000000000': 1 },
            ops: [
              {
                action: 'set' as const,
                obj: branch2ObjId.obj, // todo: fill in object id of branch1
                key: 'leaf1',
                value: 'hello',
              },
            ],
          },
        }),
      ])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(finalDoc))
      assert.deepEqual(frontend, {
        branch1: {
          leaf1: 'hello',
          branch2: {
            leaf2: '',
          },
        },
      })
    })

    // todo: test other ops inside changes, besides just set
    // use makeMap and link to create a new object in the change

    // todo: when we remove an obj property, make sure to swallow makemap + link ops
  })

  describe('arrays', () => {
    const ARRAY_V1_LENS_CHANGE = {
      from: 'mu',
      to: 'array-v1',
      lens: [addProperty({ name: 'tags', type: 'array', items: { type: 'string' } })],
    }

    const ARRAY_V2_LENS_CHANGE = {
      from: 'array-v1',
      to: 'array-v2',
      lens: [addProperty({ name: 'other', type: 'string' })],
    }

    const ARRAY_V3_LENS_CHANGE = {
      kind: 'lens' as const,
      from: 'array-v2',
      to: 'array-v3',
      lens: [renameProperty('tags', 'newtags')],
    }

    interface ArrayTestDoc {
      tags: string[]
    }

    it('can accept a single schema and fill out default values', () => {
      const cambria = Cambria.init({
        schema: 'array-v1',
        lenses: [ARRAY_V1_LENS_CHANGE],
      })
      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria))
      assert.deepEqual(frontend, {
        tags: [],
      })
    })

    it('can write and read to an array via push (no lens conversion)', () => {
      const cambria = Cambria.init({
        schema: 'array-v1',
        lenses: [ARRAY_V1_LENS_CHANGE],
      })
      const changeMaker = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria))

      const [, change] = Frontend.change<unknown, ArrayTestDoc>(changeMaker, (doc) => {
        doc.tags.push('fun')
        doc.tags.push('relaxing')
        doc.tags.push('lovecraftian')
      })

      const [cambria2] = Cambria.applyChanges(cambria, [mkBlock({ schema: 'array-v1', change })])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria2))
      assert.deepEqual(frontend, {
        tags: ['fun', 'relaxing', 'lovecraftian'],
      })
    })

    it('can write and read to an array via assignment (no lens conversion)', () => {
      const cambria = Cambria.init({
        schema: 'array-v1',
        lenses: [ARRAY_V1_LENS_CHANGE],
      })
      const changeMaker = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria))

      const [, change] = Frontend.change<unknown, ArrayTestDoc>(changeMaker, (doc) => {
        doc.tags = ['maddening', 'infuriating', 'adorable']
      })

      const [cambria2] = Cambria.applyChanges(cambria, [mkBlock({ schema: 'array-v1', change })])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria2))
      assert.deepEqual(frontend, {
        tags: ['maddening', 'infuriating', 'adorable'],
      })
    })

    it('can insert/replace array elements w/ an unrelated lens conversion', () => {
      const cambria = Cambria.init({
        schema: 'array-v1',
        lenses: [ARRAY_V1_LENS_CHANGE, ARRAY_V2_LENS_CHANGE],
      })
      const changeMaker = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria))

      const [initialDoc, change] = Frontend.change<unknown, ArrayTestDoc>(changeMaker, (doc) => {
        doc.tags.push('maddening')
        doc.tags.push('infuriating')
        doc.tags.push('adorable')
      })
      const [, overwriteChange] = Frontend.change<unknown, ArrayTestDoc>(initialDoc, (doc) => {
        doc.tags[1] = 'excruciating'
      })

      // this is all wrong now!!! isn't lensing
      const [cambria2, , block2] = Cambria.applyLocalChange(cambria, change)
      const [cambria3, , block3] = Cambria.applyLocalChange(cambria2, overwriteChange)

      const v2state1 = Cambria.init({
        schema: 'array-v2',
        lenses: [ARRAY_V1_LENS_CHANGE, ARRAY_V2_LENS_CHANGE],
      })

      const [v2state2] = Cambria.applyChanges(v2state1, [block2, block3])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(v2state2))
      assert.deepEqual(frontend, {
        other: '',
        tags: ['maddening', 'excruciating', 'adorable'],
      })
    })

    it('can insert/replace array elements in a single change', () => {
      const doc1 = Cambria.init({
        schema: 'array-v2',
        lenses: [ARRAY_V1_LENS_CHANGE, ARRAY_V2_LENS_CHANGE],
      })

      // fill in default values by applying an empty change
      const [, initialPatch] = Cambria.applyChanges(doc1, [])

      // fill in default values by applying a patch full of defaults
      const changeMaker = Frontend.applyPatch(Frontend.init(), initialPatch)
      const [, change] = Frontend.change<unknown, ArrayTestDoc>(changeMaker, (doc) => {
        doc.tags.push('el0')
        doc.tags.push('el1')
        doc.tags.push('el2')
        doc.tags[1] = 'new1'
      })

      const [, arrayPatch] = Cambria.applyChanges(doc1, [mkBlock({ schema: 'array-v1', change })])

      let doc = Frontend.applyPatch(Frontend.init(), initialPatch)
      doc = Frontend.applyPatch(doc, arrayPatch)

      assert.deepEqual(doc, {
        other: '',
        tags: ['el0', 'new1', 'el2'],
      })
    })

    it('can write to an array via assignment with an unrelated lens conversion', () => {
      const doc1 = Cambria.init({
        schema: 'array-v2',
        lenses: [ARRAY_V1_LENS_CHANGE, ARRAY_V2_LENS_CHANGE],
      })

      // fill in default values by applying an empty change
      const [, initialPatch] = Cambria.applyChanges(doc1, [])

      // fill in default values by applying a patch full of defaults
      const changeMaker = Frontend.applyPatch(Frontend.init(), initialPatch)
      const [, change] = Frontend.change<unknown, ArrayTestDoc>(changeMaker, (doc) => {
        doc.tags = ['maddening', 'infuriating', 'adorable']
      })

      const [, arrayPatch] = Cambria.applyChanges(doc1, [mkBlock({ schema: 'array-v1', change })])

      let doc = Frontend.applyPatch(Frontend.init(), initialPatch)
      doc = Frontend.applyPatch(doc, arrayPatch)

      assert.deepEqual(doc, {
        other: '',
        tags: ['maddening', 'infuriating', 'adorable'],
      })
    })

    it('can handle array deletes', () => {
      // this lens has nothing to do with arrays but still pushes the patch thru cambria
      const cambria = Cambria.init({
        schema: 'array-v2',
        lenses: [ARRAY_V1_LENS_CHANGE, ARRAY_V2_LENS_CHANGE],
      })
      const changeMaker = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria))

      const [docWithArrays, change] = Frontend.change<unknown, ArrayTestDoc>(changeMaker, (doc) => {
        doc.tags.push('maddening')
        doc.tags.push('infuriating')
        doc.tags.push('adorable')
      })
      const [, delChange] = Frontend.change<unknown, ArrayTestDoc>(docWithArrays, (doc) => {
        delete doc.tags[1]
      })

      const [cambria2] = Cambria.applyLocalChange(cambria, change)
      const [cambria3] = Cambria.applyLocalChange(cambria2, delChange)

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria3))
      assert.deepEqual(frontend, {
        other: '',
        tags: ['maddening', 'adorable'],
      })
    })
  })

  describe('arrays of objects', () => {
    // add an array of assignee objects with ID and name
    const ARRAY_OBJECT_LENS_1 = {
      from: 'mu',
      to: 'array-object-v1',
      lens: [
        addProperty({ name: 'assignees', type: 'array', items: { type: 'object' } }),
        inside('assignees', [
          map([
            addProperty({ name: 'id', type: 'string' }),
            addProperty({ name: 'name', type: 'string' }),
          ]),
        ]),
      ],
    }

    // an unrelated lens, just to minimally trigger lens conversion
    const ARRAY_OBJECT_LENS_2 = {
      from: 'array-object-v1',
      to: 'array-object-v2',
      lens: [addProperty({ name: 'other', type: 'string' })],
    }

    interface ArrayObjectTestDoc {
      assignees: Array<{ id?: string; name: string }>
    }

    it('can accept a single schema and fill out empty array', () => {
      const cambria = Cambria.init({
        schema: 'array-object-v1',
        lenses: [ARRAY_OBJECT_LENS_1],
      })
      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria))
      assert.deepEqual(frontend, {
        assignees: [],
      })
    })

    it('can insert/overwrite objects in array', () => {
      // In this test, we do a lens conversion from v1 to v2;
      // the v1->v2 lens doesn't affect the actual data but it does force cambriamerge
      // to push the change through cambria.
      // So far these changes have all fields filled in in the newly inserted objects;
      // we don't test default value injection yet. (More on that below)

      const cambria = Cambria.init({
        schema: 'array-object-v1',
        lenses: [ARRAY_OBJECT_LENS_1, ARRAY_OBJECT_LENS_2],
      })
      const changeMaker = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(cambria))

      const [initialDoc, change] = Frontend.change<unknown, ArrayObjectTestDoc>(
        changeMaker,
        (doc) => {
          doc.assignees.push({ id: '1', name: 'Alice' })
          doc.assignees.push({ id: '2', name: 'Bob' })
        }
      )
      const [, overwriteChange] = Frontend.change<unknown, ArrayObjectTestDoc>(
        initialDoc,
        (doc) => {
          doc.assignees[1] = { name: 'Bobby' }
        }
      )

      const [cambria2, , block2] = Cambria.applyLocalChange(cambria, change)
      const [cambria3, , block3] = Cambria.applyLocalChange(cambria2, overwriteChange)

      const v2state1 = Cambria.init({
        schema: 'array-object-v2',
        lenses: [ARRAY_OBJECT_LENS_1, ARRAY_OBJECT_LENS_2],
      })

      const [v2state2] = Cambria.applyChanges(v2state1, [block2, block3])

      const frontend = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(v2state2))
      assert.deepEqual(frontend, {
        other: '',
        assignees: [
          { id: '1', name: 'Alice' },
          { id: '', name: 'Bobby' }, // id: '' got filled in as default
        ],
      })
    })
  })
  describe('wrap/head behavior', () => {
    const WRAP_LENSES = [
      {
        from: 'mu',
        to: 'scalar',
        lens: [addProperty({ name: 'assignee', type: ['string', 'null'], default: 'Bob' })],
      },
      {
        from: 'scalar',
        to: 'wrap',
        lens: [renameProperty('assignee', 'assignees'), wrapProperty('assignees')],
      },
    ]

    interface WrapDoc {
      assignees: string[]
    }

    interface ScalarDoc {
      assignee: string | null
    }

    it('can handle wrap/head behavior', () => {
      let wBack = Cambria.init({
        schema: 'wrap',
        lenses: WRAP_LENSES,
      })
      let sBack = Cambria.init({
        schema: 'scalar',
        lenses: WRAP_LENSES,
      })
      let change
      let request
      let patch
      let wFront = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(wBack))
      let sFront = Frontend.applyPatch(Frontend.init(), Cambria.getPatch(sBack))

      assert.deepEqual(wFront, { assignees: [] })
      assert.deepEqual(sFront, { assignee: 'Bob' })
      ;[sFront, request] = Frontend.change(sFront, (doc: ScalarDoc) => {
        doc.assignee = null
      })
      ;[sBack, patch, change] = Cambria.applyLocalChange(sBack, request)
      sFront = Frontend.applyPatch(sFront, patch)
      ;[wBack, patch] = Cambria.applyChanges(wBack, [change])
      wFront = Frontend.applyPatch(wFront, patch)

      assert.deepEqual(wFront, { assignees: [] })
      assert.deepEqual(sFront, { assignee: null })
      ;[sFront, request] = Frontend.change(sFront, (doc: ScalarDoc) => {
        doc.assignee = 'Joe'
      })
      ;[sBack, patch, change] = Cambria.applyLocalChange(sBack, request)
      sFront = Frontend.applyPatch(sFront, patch)
      ;[wBack, patch] = Cambria.applyChanges(wBack, [change])
      wFront = Frontend.applyPatch(wFront, patch)

      assert.deepEqual(wFront, { assignees: ['Joe'] })
      assert.deepEqual(sFront, { assignee: 'Joe' })
      ;[sFront, request] = Frontend.change(sFront, (doc: ScalarDoc) => {
        doc.assignee = 'Tim'
      })
      ;[sBack, patch, change] = Cambria.applyLocalChange(sBack, request)
      sFront = Frontend.applyPatch(sFront, patch)
      ;[wBack, patch] = Cambria.applyChanges(wBack, [change])
      wFront = Frontend.applyPatch(wFront, patch)

      assert.deepEqual(wFront, { assignees: ['Tim'] })
      assert.deepEqual(sFront, { assignee: 'Tim' })
      ;[wFront, request] = Frontend.change(wFront, (doc: WrapDoc) => {
        doc.assignees.push('Jill')
      })
      ;[wBack, patch, change] = Cambria.applyLocalChange(wBack, request)
      wFront = Frontend.applyPatch(wFront, patch)
      //console.log(deepInspect({ request, patch, change }));
      ;[sBack, patch] = Cambria.applyChanges(sBack, [change])
      sFront = Frontend.applyPatch(sFront, patch)

      assert.deepEqual(wFront, { assignees: ['Tim', 'Jill'] })
      assert.deepEqual(sFront, { assignee: 'Tim' })
      ;[wFront, request] = Frontend.change(wFront, (doc: WrapDoc) => {
        doc.assignees.shift()
      })
      ;[wBack, patch, change] = Cambria.applyLocalChange(wBack, request)
      wFront = Frontend.applyPatch(wFront, patch)
      //console.log(deepInspect({ request, patch, change }));
      ;[sBack, patch] = Cambria.applyChanges(sBack, [change])
      sFront = Frontend.applyPatch(sFront, patch)

      assert.deepEqual(wFront, { assignees: ['Jill'] })
      assert.deepEqual(sFront, { assignee: null })
      ;[wFront, request] = Frontend.change(wFront, (doc: WrapDoc) => {
        doc.assignees[0] = 'Lisa'
      })
      ;[wBack, patch, change] = Cambria.applyLocalChange(wBack, request)
      wFront = Frontend.applyPatch(wFront, patch)
      ;[sBack, patch] = Cambria.applyChanges(sBack, [change])
      sFront = Frontend.applyPatch(sFront, patch)

      assert.deepEqual(wFront, { assignees: ['Lisa'] })
      assert.deepEqual(sFront, { assignee: 'Lisa' })
      ;[wFront, request] = Frontend.change(wFront, (doc: WrapDoc) => {
        doc.assignees.unshift('Biff')
      })
      ;[wBack, patch, change] = Cambria.applyLocalChange(wBack, request)
      wFront = Frontend.applyPatch(wFront, patch)
      ;[sBack, patch] = Cambria.applyChanges(sBack, [change])
      sFront = Frontend.applyPatch(sFront, patch)

      assert.deepEqual(wFront, { assignees: ['Biff', 'Lisa'] })
      assert.deepEqual(sFront, { assignee: 'Biff' })
    })
  })
})
