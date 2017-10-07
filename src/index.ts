//tslint:disable no-any strict-boolean-expressions
import * as os from 'os';
import * as fs from 'fs';
import * as pathmod from 'path';
import * as process from 'process';
import * as child_process from 'child_process';

import * as _ from 'lodash';
import * as crypto from 'crypto';
import * as handlebars from 'handlebars';

import * as nameGenerator from 'project-name-generator';

import * as bluebird from 'bluebird';
global.Promise = bluebird;

import * as aws from 'aws-sdk'
import * as url from 'url';

import * as request from 'request-promise-native';

import * as tv4 from 'tv4';

import * as yaml from './yaml';
import { logger } from './logger';


handlebars.registerHelper('tojson', (context: any) => JSON.stringify(context));
handlebars.registerHelper('toyaml', (context: any) => yaml.dump(context));
handlebars.registerHelper('base64', (context: any) => new Buffer(context).toString('base64'));

function interpolateHandlebarsString(templateString: string, env: object, errorContext: string) {
  try {
    const template = handlebars.compile(templateString, {noEscape: true, strict: true});
    return template(env);
  } catch (e) {
    throw new Error(
      `Error in string template at ${errorContext}:\n       ${e.message}\n       Template: ${templateString}`)
  }
}

export type SHA256Digest = string;

export interface CfnDoc {
  AWSTemplateFormatVersion?: '2010-09-09',
  Description?: string,
  Parameters?: object,
  Conditions?: object,
  Resources?: object,
  Outputs?: object,
  Mappings?: object,
  Metadata?: object,
  Transform?: object
};

export type ImportLocation = string; // | {From: string, As: string}

export type ImportRecord = {
  key: string | null,
  "from": ImportLocation,
  imported: ImportLocation,
  sha256Digest: SHA256Digest,
};

export type $EnvValues = {[key: string]: any} // TODO might need more general value type

export type $param = {
  Name: string,
  Default?: any,
  Type?: any,
  Schema?: any,
  AllowedValues?: any[],
  AllowedPattern?: string,
};

// TODO find a better name for this Interface
export interface ExtendedCfnDoc extends CfnDoc {
  $imports?: {[key: string]: any},
  $defs?: {[key: string]: any},
  $params?: Array<$param>,
  $location: string,
  $envValues?: $EnvValues
};

const GlobalSections = {
  Parameters: 'Parameters',
  Metadata: 'Metadata',
  Mappings: 'Mappings',
  Conditions: 'Conditions',
  Transform: 'Transform',
  Outputs: 'Outputs',
};
type GlobalSection = keyof typeof GlobalSections;

type StackFrame = {location: string, path: string};
type MaybeStackFrame = {location?: string, path: string};

type Env = {
  GlobalAccumulator: CfnDoc,
  $envValues: $EnvValues,
  Stack: StackFrame[]
};

export type ImportData = {
  importType: ImportType
  resolvedLocation: ImportLocation // relative-> absolute, etc.
  data: string
  doc?: any
}

export type ImportType =
  "ssm" | "ssm-path" | "file" | "s3" | "http" | "env" | "git" | "random" | "filehash" | "literal";
// https://github.com/kimamula/ts-transformer-enumerate is an alternative to this
// repetition. Could also use a keyboard macro.
const importTypes: ImportType[] = [
  "ssm", "ssm-path", "file", "s3", "http", "env", "git", "random", "filehash", "literal"];
const localOnlyImportTypes: ImportType[] = ["file", "env"];

// npm:version npm:project-name, etc. with equivs for lein/mvn
// cfn://stacks/{StackName}/[Outputs,Resources]
// cfn://exports/{ExportName}
// see https://github.com/ampedandwired/bora/blob/master/README.md

type GitValue = "branch" | "describe" | "sha";
const gitValues = ["branch", "describe", "sha"];

function gitValue(valueType: GitValue): string {
  const command = {
    branch:'git rev-parse --abbrev-ref HEAD',
    describe:'git describe --dirty',
    sha:'git rev-parse HEAD'
  }[valueType];

  const result = child_process
    .spawnSync(command, [], {shell: true});
  if (result.status > 0) {
    throw new Error('git value lookup failed. Are you inside a git repo?');
  } else {
    return result.stdout.toString().trim();
  }
}

const sha256Digest = (content: string | Buffer): SHA256Digest =>
  crypto.createHash('sha256').update(content.toString()).digest('hex');

function resolveHome(path: string) {
    if (path[0] === '~') {
        return pathmod.join(process.env.HOME as string, path.slice(1));
    } else {
      return path;
    }
}

const normalizePath = (...pathSegments: string[]) : string =>
  pathmod.resolve.apply(pathmod, _.map(pathSegments, (path) => resolveHome(path.trim())));

const _isPlainMap = (node: any): boolean =>
  _.isObject(node) &&
  !node.is_yaml_tag &&
  !_.isDate(node) &&
  !_.isRegExp(node) &&
  !_.isFunction(node);

const _flatten = <T>(arrs: T[]) => [].concat.apply([], arrs);

const _liftKVPairs = (objects: {key: string, value: any}[]) =>
  _.fromPairs(_.map(objects, ({key, value}) => [key, value]))

const mkSubEnv = (env: Env, $envValues: any, frame: MaybeStackFrame): Env => {
  const stackFrame = {location: frame.location || env.Stack[env.Stack.length-1].location, // tslint:disable-line
                      path: frame.path};
  return {GlobalAccumulator: env.GlobalAccumulator,
          $envValues,
          Stack: env.Stack.concat([stackFrame])};
};

export function parseImportType(location: ImportLocation, baseLocation: ImportLocation): ImportType {
  const hasExplicitType = location.indexOf(':') > -1;
  const importType = hasExplicitType
    ? location.toLowerCase().split(':')[0] as ImportType
    : "file";
  const baseImportType = baseLocation.indexOf(':') > -1
    ? baseLocation.toLowerCase().split(':')[0] as ImportType
    : "file";

  if (_.includes(['s3','http'], baseImportType)) {
    if (! hasExplicitType) {
      return baseImportType;
    } else if (_.includes(localOnlyImportTypes, importType)) {
      // security cross-check
      throw new Error(`Import type ${location} in ${baseLocation} not allowed from remote template`);
    } else {
      return importType;
    }
  } else if (_.includes(importTypes, importType)) {
    return importType;
  } else {
    throw new Error(`Unknown import type ${location} in ${baseLocation}`);
  }
}

function resolveDocFromImportData(data: string, location: ImportLocation): any {
  const uri = url.parse(location);
  let ext: string;
  if ((uri.host && uri.path)) {
    ext = pathmod.extname(uri.path);
  } else {
    ext = pathmod.extname(location);
  }

  if (_.includes(['.yaml','.yml'], ext)) {
    return yaml.loadString(data, location)
  } else if (ext === '.json') {
    return JSON.parse(data);
  } else {
    return data;
  }
}

export async function readFromImportLocation(location: ImportLocation, baseLocation: ImportLocation)
: Promise<ImportData> {
  const importType = parseImportType(location, baseLocation);
  let resolvedLocation: ImportLocation, data: string, doc: any;

  // TODO handle relative paths and non-file types
  let format: string;
  const tryParseJson = (s: string) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      throw new Error(
        `Invalid ssm parameter value ${s} import from ${location} in ${baseLocation}`)
    }
  }

  const parseData = (payload: string, formatType?: string) => {
    if (formatType === 'json') {
      return tryParseJson(payload);
    } else if (formatType === 'yaml') {
      return yaml.loadString(payload, 'location');
    } else {
      return payload
    }
  }

  switch (importType) {
  case "ssm":
    const ssm = new aws.SSM();
    [, resolvedLocation, format] = location.split(':')
    const param =
      await ssm.getParameter({Name: resolvedLocation, WithDecryption: true}).promise()
    if (param.Parameter && param.Parameter.Value) {
      data = parseData(param.Parameter.Value, format);
      return {importType, resolvedLocation, data, doc: data}
    } else {
      throw new Error(
        `Invalid ssm parameter ${resolvedLocation} import at ${baseLocation}`);
    }
  case "ssm-path":
    const ssm2 = new aws.SSM();
    [, resolvedLocation, format] = location.split(':')
    if ( ! resolvedLocation.endsWith('/')) {
      resolvedLocation += '/'
    }
    const params = await ssm2.getParametersByPath(
      {Path: resolvedLocation, WithDecryption:true}).promise()
    doc = _.fromPairs(_.map(params.Parameters, ({Name, Value})=>
                            [(Name as string).replace(resolvedLocation,''),
                             parseData(Value as string, format)]))
    return {importType, resolvedLocation, data: JSON.stringify(doc), doc}
  case "s3":
    const s3 = new aws.S3();
    if (location.indexOf('s3:') === 0) {
      resolvedLocation = location;
    } else {
      resolvedLocation = 's3:/' + pathmod.join(pathmod.dirname(baseLocation.replace('s3:/', '')), location)
    }
    const uri = url.parse(resolvedLocation)

    if (uri.host && uri.path) {
      const s3response = await s3.getObject({
        Bucket: uri.host,
        Key: uri.path.slice(1)  // doesn't like leading /
      }).promise()
      if (s3response.Body) {
        data = s3response.Body.toString();
        doc = resolveDocFromImportData(data, resolvedLocation);
        return {importType, resolvedLocation, data, doc}
      } else {
        throw new Error(`Invalid s3 response from ${location} under ${baseLocation}`);
      }
    }
    throw new Error(`Invalid s3 uri ${location} under ${baseLocation}`);
  case "http":
    resolvedLocation = location
    data = await request.get(location)
    doc = resolveDocFromImportData(data, resolvedLocation)
    return {importType, resolvedLocation, data, doc}
  case "env":
    let defVal;
    [, resolvedLocation, defVal] = location.split(':')
    data = _.get(process.env, resolvedLocation, defVal)
    if (_.isUndefined(data)) {
      throw new Error(`Env-var ${resolvedLocation} not found from ${baseLocation}`)
    }
    return {importType, resolvedLocation, data, doc: data};
  case "git":
    resolvedLocation = location.split(':')[1]
    if (_.includes(gitValues, resolvedLocation)) {
      data = gitValue(resolvedLocation as GitValue);
      return {importType, resolvedLocation, data, doc: data};
    } else {
      throw new Error(`Invalid git command: ${location}`);
    }
  case "random":
    resolvedLocation = location.split(':')[1]
    if (resolvedLocation === 'dashed-name') {
      data = nameGenerator().dashed;
    } else if (resolvedLocation === 'name') {
      data = nameGenerator().dashed.replace('-','');
    } else if (resolvedLocation === 'int') {
      const max = 1000, min = 1;
      data = (Math.floor(Math.random() * (max - min)) + min).toString();
    } else {
      throw new Error(`Invalid random type in ${location} at ${baseLocation}`);
    }
    return {importType, resolvedLocation, data, doc: data};
  case "filehash":
    resolvedLocation = normalizePath(pathmod.dirname(baseLocation), location.split(':')[1]);
    if (! fs.existsSync(resolvedLocation)) {
      throw new Error(`Invalid location ${resolvedLocation} for filehash in ${baseLocation}`);
    }
    const isDir = fs.lstatSync(resolvedLocation).isDirectory();
    const shasumCommand = 'shasum -p -a 256';
    const hashCommand = isDir
      ? `find ${resolvedLocation} -type f -print0 | xargs -0 ${shasumCommand} | ${shasumCommand}`
      : `${shasumCommand} ${resolvedLocation}`;
    const result = child_process.spawnSync(hashCommand, [], {shell:true});
    data = result.stdout.toString().trim().split(' ')[0]
    return {importType, resolvedLocation, data, doc: data}
  case "literal":
    logger.warn(`literal: $imports are deprecated. Replace ${location} in ${baseLocation} with '$defs'.`)
    resolvedLocation = location.split(':')[1]
    data = resolvedLocation;
    doc = data;
    return {importType, resolvedLocation, data, doc}
  case "file":
    if (_.some(_.filter(importTypes, 'file')), (typ:string) => baseLocation.startsWith(`${typ}:`)) {
      logger.debug(`non file: import on baseLocation=${baseLocation} for location=${location}`)
    }
    resolvedLocation = pathmod.resolve(pathmod.dirname(baseLocation.replace('file:','')), location.replace('file:', ''));
    data = (await bluebird.promisify(fs.readFile)(resolvedLocation)).toString();
    return {importType, resolvedLocation, data, doc: resolveDocFromImportData(data, resolvedLocation)}
  }
}

async function loadImports(
  doc: ExtendedCfnDoc,
  baseLocation: ImportLocation,
  importsAccum: ImportRecord[],
  importLoader=readFromImportLocation  // for mocking in tests
): Promise<void> {
  // recursively load the entire set of imports
  doc.$envValues = {};
  if (doc.$imports) {

    if ( ! _.isPlainObject(doc.$imports)) {
      throw Error(
        `Invalid imports in ${baseLocation}:\n "${JSON.stringify(doc.$imports)}". \n Should be mapping.`);
    }

    for (const asKey in doc.$imports) {
      let loc = doc.$imports[asKey];
      if (loc.search(/{{(.*?)}}/) > -1) {
        loc = interpolateHandlebarsString(loc, doc.$envValues, `${baseLocation}: ${asKey}`);
      }

      logger.debug('loading import:', loc, asKey);
      const importData = await importLoader(loc, baseLocation);
      if (_.isObject(importData.doc)) {
        importData.doc.$location = loc;
      }

      importsAccum.push({
        from: baseLocation,
        imported: importData.resolvedLocation,
        sha256Digest: sha256Digest(importData.data),
        key: asKey
      });

      if (_.includes(doc.$envValues, asKey)) {
        throw new Error(`Duplicate import name ${asKey} in ${baseLocation}`);
      }
      doc.$envValues[asKey] = importData.doc;
      if (importData.doc.$imports || importData.doc.$defs) {
        await loadImports(
          importData.doc, importData.resolvedLocation, importsAccum, importLoader)
      }
    }
  }
  if (doc.$defs) {
    for (const key in doc.$defs) {
      if (_.includes(_.keys(doc.$envValues), key)) {
        throw new Error(
          `"${key}" in $defs collides with the same name in $imports of ${baseLocation}`)
      }
      doc.$envValues[key] = doc.$defs[key];
    }
  }
  if (doc.$params) {
    // guard against name clashes
    for (const {Name} of doc.$params) {
      if (_.includes(_.keys(doc.$envValues), Name)) {
        throw new Error(
          `"${Name}" in $params collides with "${Name}" in $imports or $defs of ${baseLocation}`)
      }
    }
  }


};

function lookupInEnv(key: string, path: string, env: Env) {
  if (typeof key !== 'string') { // tslint:disable-line
    // this is called with the .data attribute of custom yaml tags which might not be
    // strings.
    throw new Error(`Invalid lookup key ${JSON.stringify(key)} at ${path}`)
  }
  const res = env.$envValues[key];
  if (_.isUndefined(res)) {
    logger.debug(`Could not find "${key}" at ${path}}`, env=env)
    throw new Error(`Could not find "${key}" at ${path}}`);
  } else {
    return res;
  }
}

const appendPath = (rootPath: string, suffix: string) =>
  rootPath ? rootPath + '.' + suffix : suffix;

function mapCustomResourceToGlobalSections(
  resourceDoc: CfnDoc,
  path: string,
  env: Env
): void {
  _.forOwn(GlobalSections, (section: GlobalSection) => {
    if (resourceDoc[section]) {
      const res = _.merge(
        env.GlobalAccumulator[section], // mutate in place
        _.fromPairs(
          // TOOD is this the right place to be visiting the subsections
          _.map(_.toPairs(visitNode(resourceDoc[section], appendPath(path, section), env)),
                ([k, v]) => [`${env.$envValues.Prefix}${k}`, v]))
      );
      return res;
    }
  });
}

const visitMapNode = (node: any, path: string, env: Env): any => {
  // without $merge it would just be:
  //return  _.mapValues(node, (v, k) => visitNode(v, appendPath(path, k), env));
  const res: any = {};
  for (const k in node) {
    if (k.indexOf('$merge') === 0) {
      const sub: any = visitNode(node[k], appendPath(path, k), env);
      for (const k2 in sub) {
        if (_.has(res, k2)) {
          throw new Error(
            `Key "${k2}" is already present and cannot be $merge'd into path "${path}"`);
        }
        res[k2] = sub[k2]; //visitNode(sub[k2], appendPath(path, k2), env);
      }
    } else if (_.includes(['$envValues', '$imports', '$params', '$location'], k)) {
      // TODO test this part more thoroughly
      continue;
    } else {
      res[k] = visitNode(node[k], appendPath(path, k), env);
    }
  }
  return res;
}

const visitArray = (node: any[], path: string, env: Env): any =>
  _.map(node, (v, i) => visitNode(v, appendPath(path, i.toString()), env));

function visitStringNode(node: string, path: string, env: Env): any {
  if (node.search(/{{(.*?)}}/) > -1) {
    return interpolateHandlebarsString(node, env.$envValues, path);
  } else {
    return node;
  }
}

// TODO tighten up the return type here: {[key: string]: any}
const visitResourceNode = (node: object, path: string, env: Env): any =>
  _.fromPairs(
    _flatten( // as we may output > 1 resource for each template
      _.map(_.toPairs(node), ([name, resource]) => {
        const template: ExtendedCfnDoc = env.$envValues[resource.Type];
        if (template) {
          // TODO s/NamePrefix/$namePrefix/
          const prefix = _.isUndefined(resource.NamePrefix) ? name : resource.NamePrefix;
          const stackFrame = {location: template.$location, path: appendPath(path, name)};
          const resourceDoc = _.merge(
            {}, template,
            visitNode(resource.Overrides,
                      appendPath(path, `${name}.Overrides`),
                      // This is pre template expansion so the names
                      // used by $include, etc. must be in scope of the current
                      // environment, not in the template's env.
                      env))

          const $paramDefaultsEnv = mkSubEnv(
            env, _.merge({Prefix: prefix}, template.$envValues), stackFrame);

          const $paramDefaults = _.fromPairs(
            _.filter(
              _.map(
                template.$params,
                (v) => [v.Name,
                        visitNode(v.Default, appendPath(path, `${name}.$params.${v.Name}`), $paramDefaultsEnv)]),
              ([k, v]) => ! _.isUndefined(v)));

          const providedParams = visitNode(resource.Properties, appendPath(path, `${name}.Properties`), env);
          // TODO factor this out:
          // TODO validate providedParams against template.$params[].type json-schema
          // ! 1 find any missing params with no defaults
          // 2 check against AllowedValues and AllowedPattern
          // 3 check min/max Value / Length
          const mergedParams = _.merge({}, $paramDefaults, providedParams);
          _.forEach(template.$params, (param)=> {
            const paramValue = mergedParams[param.Name];
            if (_.isUndefined(paramValue)) {
              throw new Error(`Missing required parameter ${param.Name} in ${name}`);
            } else if (param.Schema) {
              if (! _.isObject(param.Schema)) {
                throw new Error(`Invalid schema "${param.Name}" in ${name}.`)
              }
              const validationResult = tv4.validateResult(paramValue, param.Schema)
              if (! validationResult.valid) {
                const errmsg = `Parameter validation error for "${param.Name}" in ${name}.`;
                logger.error(errmsg);
                logger.error(`  ${env.Stack[env.Stack.length-1].location || ''}`)
                logger.error(validationResult.error.message);
                logger.error('Here is the parameter JSON Schema:\n'+yaml.dump(param.Schema));
                throw new Error(errmsg);
              }
            } else if (param.AllowedValues) {
                // cfn style validation
              if (!_.includes(param.AllowedValues, paramValue)) {
                const errmsg = `Parameter validation error for "${param.Name}" in ${name}.`;
                logger.error(errmsg);
                logger.error(`  ${env.Stack[env.Stack.length-1].location || ''}`)
                logger.error(`${paramValue} not in Allowed Values: ${yaml.dump(param.AllowedValues)}`);
                throw new Error(errmsg);
              }
            } else if (param.AllowedPattern) {
              // TODO test
              const patternRegex = new RegExp(param.AllowedPattern);
              if (! (typeof paramValue === 'string' && paramValue.match(patternRegex))) {
                throw new Error(`Invalid value "${param.Name}" in ${name}. AllowedPattern: ${param.AllowedPattern}.`)
              }
            }

          })

          const subEnv = mkSubEnv(
            env,
            _.merge(
              {Prefix: prefix},
              $paramDefaults,
              providedParams,
              template.$envValues),
            stackFrame);

          // TODO consider just visitNode on the entire resourceDoc here
          //      ... that requires finding a way to avoid double processing of .Resources
          const outputResources = visitNode(resourceDoc.Resources, appendPath(path, `${name}.Resources`), subEnv)
          // this will call visitNode on each section as it goes. See above ^
          mapCustomResourceToGlobalSections(resourceDoc, path, subEnv);

          // TODO allow individual output resources to have distinct $namePrefixes
          //    prefix could be a map of resname: prefix
          // Could also add a special char prefix individual resource names and global sections to
          // override this name remapping.
          // This ties in with supporting singleton custom resources that should be shared amongst templates
          return _.map(_.toPairs(outputResources), ([resname, val]) => [`${subEnv.$envValues.Prefix}${resname}`, val])

        } else if (resource.Type &&
                   (resource.Type.indexOf('AWS') === 0
                    || resource.Type.indexOf('Custom') === 0)) {
          return [[name, visitNode(resource, appendPath(path, name), env)]]
        } else {
          throw new Error(
            `Invalid resource type: ${resource.Type} at ${path}: ${JSON.stringify(resource, null, ' ')}`)
        }
      })
    ));

function visit$Expand(node: yaml.$expand, path: string, env: Env): any {
  if (! _.isEqual(_.sortBy(_.keys(node.data)), [ 'params', 'template' ])) {
    // TODO use json schema instead
    throw new Error(`Invalid arguments to $expand: ${_.sortBy(_.keys(node.data))}`);
  } else {
    const {template: templateName, params} = node.data;
    const template = _.clone(lookupInEnv(templateName, path, env));
    // TODO validate the params
    // TODO expand template.$params defaults
    const subEnv = mkSubEnv(env, _.merge({}, params, env.$envValues), {path});
    delete template.$params;
    // TODO might also need to delete template.$imports, template.$envValues, and template.$defs
    return visitNode(template, path, subEnv);
  }
}

function visitYamlTagNode(node: yaml.Tag, path: string, env: Env): any {
  // TODO conditions, hoist
  if (node instanceof yaml.$include) {
    if (node.data.indexOf('.') > -1) {
      const [key, ...selector] = node.data.split('.');
      if (! _.has(env.$envValues, key)) {
        throw new Error(`Could not find "${key}" at ${path}`);
      }
      const lookupRes: any = _.get(env.$envValues[key], selector);
      if (_.isUndefined(lookupRes)) {
        throw new Error(`Could not find path ${selector} in ${key} at ${path}`);
      } else {
        return visitNode(lookupRes, path, env);
      }
    } else {
      return visitNode(lookupInEnv(node.data, path, env), path, env);
    }
  } else if (node instanceof yaml.$expand) {
    return visit$Expand(node, path, env);
  } else if (node instanceof yaml.$escape) {
    return node.data;
  } else if (node instanceof yaml.$string) {
    const stringSource = (_.isArray(node.data) && node.data.length === 1)
      ? node.data[0]
      : node.data;
    return yaml.dump(visitNode(stringSource, path, env)) ;
  } else if (node instanceof yaml.$parseYaml) {
    return visitNode(yaml.loadString(visitNode(node.data, path, env), path), path, env);
  } else if (node instanceof yaml.$let) {
    const subEnv = mkSubEnv(
      env,
      _.merge({}, env.$envValues, visitNode(_.omit(node.data, ['in']), path, env)),
      {path});
    return visitNode(node.data.in, path, subEnv);
  } else if (node instanceof yaml.$map) {
    // TODO validate node.data's shape or even better do this during parsing
    //    template: any, items: [...]
    const template = node.data.template;
    // TODO handle nested maps
    const varName = node.data.var || 'item';
    const mapped = _.map(node.data.items, (item0: any, idx: number) => {
      // TODO improve stackFrame details
      const subPath = appendPath(path, idx.toString());
      const item = visitNode(item0, subPath, env); // visit pre expansion
      const subEnv = mkSubEnv(
        env, _.merge({[varName]:item, [varName+'Idx']:idx}, env.$envValues), {path: subPath});
      return visitNode(template, subPath, subEnv);
    }) ;
    return visitNode(mapped, path, env); // TODO do we need to visit again like this?
  } else if (node instanceof yaml.$flatten) {
    if (!_.isArray(node.data) && _.every(node.data, _.isArray)) {
      throw new Error(`Invalid argument to $flatten at "${path}".`
                      + " Must be array of arrays.");
    }
    return visitNode(_flatten(node.data), path, env);
  } else if (node instanceof yaml.$concatMap) {
    return _flatten(visitNode(new yaml.$map(node.data), path, env));
  } else if (node instanceof yaml.$mapListToHash) {
    const input = new yaml.$map(node.data);
    return _liftKVPairs(visitNode(input, path, env));
  } else if (node instanceof yaml.$fromPairs) {
    // TODO validate node.data's shape or even better do this during parsing
    //   [{key:string, value:any}]
    return visitNode(_liftKVPairs(node.data), path, env);
  } else if (node instanceof yaml.Ref) {
    // TODO test to verify that this works on top level templates that
    // have no .Prefix
    // TODO handle other tags such as !GetAtt
    if (_.isString(node.data) && node.data.startsWith('AWS:')) {
      return node;
    } else {
      return new yaml.customTags.Ref(`${env.$envValues.Prefix || ''}${node.data}`);
    }

  } else {
    return node.update(visitNode(node.data, path, env));
  }
}

function visitImportedDoc(node: ExtendedCfnDoc, path: string, env: Env): any {
  // This node comes from a yaml or json document that was imported.
  // We need to resolve/reify all !$ includes fully rather than
  // letting them leak out of the documents $imports: scope and be
  // resolved incorrectly if they're used in other scopes. If we
  // didn't do this any values defined with $defs: in a document that
  // is then imported into other documents would be unresolvable.

  // To achieve this, before calling visitNode on the node
  // itself we visit/resolve all entries in $envValues so the
  // environment we use when visiting the node doesn't have
  // unresolved references in it.

  // TODO add tests to ensure we don't have $! leakage issues in the templates also.

  const stackFrame = {location: node.$location, path: path}; // TODO improve for Root, ...
  const subEnv0 = mkSubEnv(env, node.$envValues, {location: node.$location, path: path});
  const nodeTypes = _.groupBy(_.toPairs(node.$envValues), ([k,v])=> _.has(v, '$params'));
  const nonTemplates = _.fromPairs(_.get(nodeTypes, false));
  const templates = _.fromPairs(_.get(nodeTypes, true));
  const processedEnvValues = _.merge({}, visitNode(nonTemplates, path, subEnv0), templates);
  const subEnv = mkSubEnv(env, processedEnvValues, stackFrame);
  return visitMapNode(node, path, subEnv);
}

function visitNode(node: any, path: string, env: Env): any {
  const currNode = path.split('.').pop();
  logger.debug(`entering ${path}:`, {node, nodeType: typeof node, env});
  const result = (() => {
    // switch to a switch statement
    if (currNode === 'Resources' && path.indexOf('Overrides') === -1) {
      return visitResourceNode(node, path, env);
    } else if (currNode === '$envValues') {
      // filtered out in visitMapNode
      throw new Error(`Shouldn't be able to reach here: ${path}`);
    } else if (node instanceof yaml.Tag) {
      return visitYamlTagNode(node, path, env);
    } else if (_.isArray(node)) {
      return visitArray(node, path, env);
    } else if (_isPlainMap(node)) {
      if (node.$params) {
        throw new Error(
          `Templates should be called via !$expand or as CFN resource types: ${path}\n ${yaml.dump(node)}`);
      } else if (node.$envValues) {
        return visitImportedDoc(node, path, env);
      } else {
        return visitMapNode(node, path, env);
      }
    } else if (node instanceof Date && _.includes(['Version', 'AWSTemplateFormatVersion'], currNode)) {
      // common error in cfn / yaml
      return node.toISOString().split('T')[0];
    } else if (typeof node === 'string') {
      return visitStringNode(node, path, env);
    } else {
      return node;
    }
  })();
  logger.debug(`exiting ${path}:`, {result, node, env});;
  return result;
};

export function transformPostImports(
  root: ExtendedCfnDoc,
  rootDocLocation: ImportLocation,
  accumulatedImports: ImportRecord[]
)
: CfnDoc {
  // TODO add the rootDoc to the Imports record
  const globalAccum: CfnDoc = {
    Metadata: {
      iidy: {
        Host: os.hostname(),
        Imports: accumulatedImports,
        User: os.userInfo().username
      }
    }
  };

  const seedOutput: CfnDoc  = {};
  const isCFNDoc = root.AWSTemplateFormatVersion || root.Resources;
  if (isCFNDoc) {
    _.extend(globalAccum,
             {Parameters: {},
              Conditions: {},
              Mappings: {},
              Outputs: {}});
    seedOutput.AWSTemplateFormatVersion = '2010-09-09';
  }

  const output = _.extend(
    seedOutput,
    visitNode(root, 'Root', {
      GlobalAccumulator: globalAccum,
      $envValues: root.$envValues || {},
      Stack: [{location: rootDocLocation, path: 'Root'}]
    }));

  if (isCFNDoc) {

    // TODO check for seconary cfn docs, or stack dependencies

    _.forOwn(
      GlobalSections,
      (sectionName: GlobalSection) => {
        if (! _.isEmpty(globalAccum[sectionName])) {
          output[sectionName] = _.merge({}, output[sectionName], globalAccum[sectionName]);
        }});
  }

  // TODO merge/flatten singleton dependencies like shared custom resources
  delete output.$imports;
  delete output.$defs;
  delete output.$envValues;
  return output;
};


export async function transform(
  root0: ExtendedCfnDoc,
  rootDocLocation: ImportLocation,
  importLoader=readFromImportLocation // for mocking in tests
)
: Promise<CfnDoc> {
  const root = _.clone(root0);
  const accumulatedImports: ImportRecord[] = [];
  await loadImports(root, rootDocLocation, accumulatedImports, importLoader);
  return transformPostImports(root, rootDocLocation, accumulatedImports);
};


import { Arguments } from 'yargs';
import configureAWS from './configureAWS';

export async function renderMain(argv: Arguments): Promise<number> {
  await configureAWS(argv.profile, argv.region)
  const rootDocLocation = pathmod.resolve(argv.template);
  const content = fs.readFileSync(rootDocLocation);
  const input = yaml.loadString(content, rootDocLocation);
  const outputDoc = await transform(input, rootDocLocation);
  const outputString = yaml.dump(outputDoc);
  if (_.includes(['/dev/stdout', 'stdout'], argv.outfile)) {
    console.log(outputString);
  } else if (_.includes(['/dev/stderr', 'stderr'], argv.outfile)) {
    process.stderr.write(outputString);
    process.stderr.write('\n');
  } else {
    if (fs.existsSync(argv.outfile) && ! argv.overwrite) {
      logger.error(`outfile '${argv.outfile}' exists. Use --overwrite to proceed.`);
      return 1;
    }
    fs.writeFileSync(argv.outfile, outputString);
  }
  return 0;
};
