const {
  GraphQLSchema,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLUnionType,
  GraphQLBoolean,
  GraphQLNonNull
} = require('graphql')
const {
  uniqueId,
  map,
  find,
  mapValues,
  capitalize,
  keys,
  isEqual,
  uniq,
  debounce,
  assign,
  compact,
  flatten,
  isFunction
} = require('lodash')
const Joi = require('joi')

const cachedTypes = {}

const descToArgs = (desc) => {
  const argsSchema = map(desc.meta, 'args')[0]
  return argsSchema && mapValues(argsSchema, (schema) => ({
    type: descToType(schema.describe(), true)
  }))
}

const descToType = (desc, isInput) => {
  let typeName = (
    (isInput ? 'Input' : '') +
    (map(desc.meta, 'name')[0] || 'Anon' + uniqueId())
  )
  const required = (
    isInput &&
    desc.flags &&
    desc.flags.presence &&
    desc.flags.presence === 'required'
  )
  const type = {
    boolean: () => GraphQLBoolean,
    date: () => GraphQLString,
    string: () => GraphQLString,
    number: () => {
      const isInteger = !!find(desc.rules, { name: 'integer' })
      return isInteger ? GraphQLInt : GraphQLFloat
    },
    object: () => {
      if (cachedTypes[typeName]) return cachedTypes[typeName]
      let type
      if (isInput) {
        type = new GraphQLInputObjectType({
          name: typeName,
          description: desc.description,
          fields: mapValues(desc.children, (child) => (
            { type: descToType(child, true) }))
        })
      } else {
        type = new GraphQLObjectType({
          name: typeName,
          description: desc.description,
          fields: descsToSchema(desc.children)
        })
      }
      cachedTypes[typeName] = type
      return type
    },
    array: () => {
      let type
      if (desc.items.length === 1) {
        type = descToType(desc.items[0], isInput)
      } else {
        typeName = map(desc.items, (d) => {
          const name = (
            (d.meta && capitalize(d.meta.name)) ||
            capitalize(d.type) ||
            'Anon' + uniqueId()
          )
          return (isInput ? 'Input' : '') + name
        }).join('Or')
        if (cachedTypes[typeName]) {
          type = cachedTypes[typeName]
        } else {
          const types = desc.items.map((item) => descToType(item, isInput))
          if (isInput) {
            const children = desc.items.map((item) => item.children)
            const fields = descsToSchema(assign(...flatten(children)))
            type = new GraphQLInputObjectType({
              name: typeName,
              description: desc.description,
              fields: fields
            })
          } else {
            type = new GraphQLUnionType({
              name: typeName,
              description: desc.description,
              types: types,
              // TODO: Should use JOI.validate(), just looks at matching keys
              // We might need to pass schema here instead
              resolveType: (val) =>
                find(map(desc.items, (item, i) =>
                  isEqual(keys(val), keys(item.children)) && types[i]))
            })
          }
        }
      }
      if (!cachedTypes[typeName]) cachedTypes[typeName] = type
      return new GraphQLList(type)
    }
  }[desc.type]()
  return required ? new GraphQLNonNull(type) : type
}

const selToVal = (selection) => {
  const fns = {
    StringValue: () => selection.value,
    ListValue: () => map(selection.values, selToVal),
    ObjectValue: () => assign(...map(selection.fields, (field) =>
      ({ [field.name.value]: selToVal(field.value) })))
  }
  if (!fns[selection.kind]) {
    console.log(selection)
    throw new Error(`Unsupported kind ${selection.kind}`)
  }
  return fns[selection.kind]()
}

const mapArgs = (args) => {
  return assign(...map(args, (arg) =>
    ({ [arg.name.value]: selToVal(arg.value) }))
  )
}

const validateArgs = (desc, args) => {
  const argsSchema = map(desc.meta, 'args')[0]
  if (!argsSchema) return {}
  const { value, error } = Joi.validate(args, argsSchema)
  if (error) throw error
  return value
}

const mapSelections = (desc, selections) => {
  const kinds = uniq(map(selections, 'kind')).join('')
  if (kinds === 'InlineFragment') {
    return selections.map((s) => mapSelections(desc, s.selectionSet.selections))
  }
  return assign(...map(selections, (selection) => {
    const key = selection.name.value
    const args = validateArgs(desc, mapArgs(selection.arguments))
    const fields = selection.selectionSet
      ? mapSelections(desc, selection.selectionSet.selections)
      : {}
    return { [key]: { args, fields } }
  }))
}

const descsToSchema = (descs, resolveMiddlewares = () => {}) => {
  const req = {}
  let finish
  const aggregate = debounce(() => { finish = resolveMiddlewares(req) })
  return mapValues(descs, (desc, key) => ({
    type: descToType(desc),
    args: descToArgs(desc),
    description: desc.description || '',
    resolve: (source, args, root, { fieldASTs }) => {
      assign(req, mapSelections(desc, fieldASTs))
      aggregate()
      if (!source) {
        return new Promise((resolve, reject) => setTimeout(() => {
          finish.then((res) => resolve(res[key])).catch(reject)
        }))
      } else return source[key]
    }
  }))
}

const schemaResolve = (jois, buildMiddlewares) => {
  const attrs = {}
  if (jois.query) {
    attrs.query = new GraphQLObjectType({
      name: 'RootQueryType',
      fields: descsToSchema(
        mapValues(jois.query, (j) => j.describe()),
        (gqlQuery) => buildMiddlewares({ query: gqlQuery })
      )
    })
  }
  if (jois.mutation) {
    attrs.mutation = new GraphQLObjectType({
      name: 'RootMutationType',
      fields: descsToSchema(
        mapValues(jois.mutation, (j) => j.describe()),
        (gqlQuery) => buildMiddlewares({ mutation: gqlQuery })
      )
    })
  }
  return new GraphQLSchema(attrs)
}

module.exports = (jois) => {
  const resolvers = []
  let res = {}
  let ended = false
  const schema = schemaResolve(jois, (gqlQuery) => {
    const state = {}
    const promiseThunks = resolvers.map(({ prop, resolve: next }) => {
      const req = prop.split('.').reduce((a, b) => a && a[b], gqlQuery)
      const ctx = {
        req,
        res,
        state,
        end: (endRes) => {
          if (endRes) res = endRes
          ended = true
        }
      }
      if (req && !ended) return () => next(ctx)
      else return () => Promise.resolve()
    })
    const final = compact(promiseThunks)
      .reduce((prev, cur) => {
        return (isFunction(prev) ? prev() : prev).then(cur)
      })
    return (isFunction(final) ? final() : final).then(() => res)
  })
  const api = {
    schema: schema,
    on: (props, resolve) => {
      props.split(' ').forEach((prop) => resolvers.push({ prop, resolve }))
      return api
    }
  }
  return api
}
