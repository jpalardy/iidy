# iidy (Is it done yet?) -- a CloudFormation CLI tool

`iidy` improves the developer experience with CloudFormation.

* It provides immediate, readable feedback about what CloudFormation
  is doing and any errors it encounters.
* Its single binary is simpler to install than Ansible's Python
  dependencies.
* It is far simpler to learn, understand, and use. There are fewer
  moving parts and its commands map directly to CloudFormation's.
* It requires less boilerplate files and directories. 2 or 3 files vs
  5+ directories with 7+ files.
* It has simple, reliable support for AWS profiles.
* It supports the full range of CloudFormation operations, including
  _changesets_ without requiring any code beyond what is required to
  create a stack. Ansible requires additional code/configuration for
  this.
* It does some template validation, guards against common issues, and
  will be extended over time to validate our best practices and
  security policies.
* It provides seemless integration with AWS ParameterStore, our choice
  for secret management going forward and our replacement for Ansible
  Vault.
* It has bash command completion support.

`iidy` also improves the developer experience working with CloudFormation
Yaml templates. It includes an optional yaml pre-processor that:

* allows values to be imported from a range of sources, including
  local files, s3, https, ParameterStore, and environment variables.
  It parses json or yaml imports. The imported data can be stitched
  into the target template as yaml subtrees, as literal strings, or as
  single values.
* can be used to define custom resource templates that expand out
  to a set of real AWS resources. These templates can be parameterized
  and can even do input validation on the parameters. The template
  expansion and validation happens as a pre-process step prior to
  invoking CloudFormation on the rendered output.

## iidy at Unbounce

`iidy` is a replacement for our use of Ansible as a wrapper around
CloudFormation. It talks to the CloudFormation API directly and
provides good user feedback while waiting for stack operations to
complete. It also uses AWS ParameterStore to replace our use of
Ansible Vault for encrypting secrets and ARNs. Ansible still has a
role in server bootstrapping, which is not a concern of `iidy`.

Over time, it will become the sole tool we use for talking to the
CloudFormation API while creating or updating stacks.

Migration from Ansible / Ansible Vault to `iidy` is **mandatory**.
However, you won't have to do the work yourself. All dev squads will
be required to accept pull requests that implement this change. These
pull requests will not change the details of your stacks once
provisioned. I.e. they will be low risk and impact tooling only. I aim
to have all production services migrated by the end of Sept 2017. Why?

1) Ansible is an unnecessary layer above CloudFormation that has a bad
UX for this use-case,

2) we want to retire Ansible Vault as our use of
it has some security issues,

3) our developers have not had a good
onboarding experience learning Ansible and CloudFormation at the same
time. It has scared people away from a good tool: CloudFormation.

4) We do not have the bandwidth to support multiple tools. Unlike
previous introductions of new tools, we are cleaning house of the old
tools before moving on.

Same for migration from Troposphere? Hell yes!

Why now? This is a step to some broader changes to the way we
provision infrastructure. It will simplify the path towards a) a
secure production account with no `#superuser` required for
deployments, b) proper separation between `staging` and `production`,
c) some architectural normalization that Roman and others are working
on. More information will be coming on these topics later.

Who supports and maintains it? Tavis. I will be providing extensive
examples, documentation, and training.

How does this relate to `Simple Infrastructure`? It's orthogonal and
complimentary. They solve different problems and can be used together.
Like all existing production stacks, `Simple Infrastructure` should be
updated to use this rather than Ansible. I am working on a pull
request.

Isn't this an example of NIH syndrome? Roman and I built a prototype
of this back in Dec. 2015. We searched for good alternatives then and
found none. I researched roughly a dozen other tools prior to
restarting work on this. Unfortunately, there are non that a) are well
documented and supported, b) have a good UX / developer experience, c)
are integrated with ParameterStore, d) expose the full CloudFormation
api, and most importantly e) are simple and unopinionated.

## Installation

* Binary installation
```
# Grab the appropriate binary from the releases page.
wget -O /usr/local/bin/iidy https://github.com/unbounce/iidy/releases/download/v1.0.0/iidy-macos
# or wget -O /usr/local/bin/iidy https://github.com/unbounce/iidy/releases/download/v1.0.0/iidy-linux
chmod +x /usr/local/bin/iidy
```

* Installing from source if you have node installed.
```
# If you already have Node 6 or above installed
git clone git@github.com:unbounce/iidy.git
cd iidy
npm install -g .
```

## Usage

### Help
```
$ iidy help
iidy (Is it done yet?) -- a tool for working with CloudFormation and yaml templates

Stack Commands:
  create-stack <argsfile>                                create a cloudformation stack
  update-stack <argsfile>                                update a cloudformation stack
  create-changeset <changesetName> <argsfile>            create a cfn changeset
  create-stack-via-changeset <changesetName> <argsfile>  create a new stack via a cfn changeset
  exec-changeset <changesetName> <argsfile>              execute a cfn changeset
  estimate-cost <argsfile>                               estimate stack costs based on stack-args.yaml
  watch-stack <stackname>                                watch a stack that is already being created or updated
  describe-stack <stackname>                             describe a stack
  get-stack-template <stackname>                         download the template of a live stack
  delete-stack <stackname>                               delete a stack (after confirmation)
  list-stacks                                            list the stacks within a region

Additional Commands:
  render <template>                                      pre-process and render cloudformation yaml templates
  completion                                             generate bash completion script

AWS Options
  --region   AWS region
  --profile  AWS profile

Options:
  -v, --version  Show version number
  -h, --help     Show help

```

### The `argsfile` (aka `stack-args.yaml`)

```
####################
# Required settings:

StackName: <string>

Template: <local file path or s3 path>

# optionally you can use the yaml pre-processor by prepending 'render:' to the filename
#Template: render:<local file path or s3 path>


####################
# Optional settings:

Region: <aws region name>

Profile: <aws profile name>

Tags: # aws tags to apply to the stack
  owner: Tavis
  environment: development
  project: iidy-docs
  lifetime: short

Parameters: # stack parameters
  key1: value
  key2: value

Capabilities: # optional list. *Preferably empty*
  - CAPABILITY_IAM
  - CAPABILITY_NAMED_IAM

NotificationARNs:
  - <sns arn>

# CloudFormation ServiceRole
RoleARN: arn:aws:iam::<acount>:role/<rolename>

TimeoutInMinutes: <number>

# OnFailure defaults to ROLLBACK
OnFailure: 'ROLLBACK' | 'DELETE' | 'DO_NOTHING'

StackPolicy: <local file path or s3 path>

ResourceTypes: <list of aws resource types allowed in the template>
  # see http://docs.aws.amazon.com/cli/latest/reference/cloudformation/create-stack.html#options

CommandsBefore: # shell commands to run prior the cfn stack operation
  - make build # for example

```

### AWS IAM Settings

`iidy` supports loading AWS IAM credentials/profiles from
    a) the cli options shown above,
    b) `Region` or `Profile` settings in `stack-args.yaml`, or
    c) the standard environment variables.

### Creating or Updating CloudFormation Stacks
...

### Creating or Executing CloudFormation Changesets
...


## Yaml Pre-Processing
...

### Imports
...

### Working With CloudFormation Yaml

#### Custom CloudFormation Resource Types
...

### Working with *Non*-CloudFormation Yaml



## Examples
See the examples/ directory.


## Development

iidy is coded in Typescript and compiles to es2015 Javascript using
commonjs modules (what Node uses). See the `Makefile` and the script
commands in `package.json` for details about the build process.

...

## Changelog

* v1.0.0: Initial Release
