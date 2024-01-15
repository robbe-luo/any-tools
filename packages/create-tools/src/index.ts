import minimist from 'minimist';
import prompts from 'prompts';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import registryUrl from 'registry-url';
import axios from 'axios';

// Avoids auto conversion to number of the project name by defining that the args
// non-associated with an option ( _ ) needs to be parsed as a string. See #4606
const argv = minimist<{
  t?: string;
  template?: string;
}>(process.argv.slice(2), { string: ['_'] });
const cwd = process.cwd();

type ColorFunc = (str: string | number) => string;
type Framework = {
  name: string;
  display: string;
  color: ColorFunc;
  variants: FrameworkVariant[];
};
type FrameworkVariant = {
  name: string;
  display: string;
  color: ColorFunc;
  customCommand?: string;
};

function formatTargetDir(targetDir: string | undefined) {
  return targetDir?.trim().replace(/\/+$/g, '');
}

function isEmpty(path: string) {
  const files = fs.readdirSync(path);
  return files.length === 0 || (files.length === 1 && files[0] === '.git');
}

function isValidPackageName(projectName: string) {
  return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(
    projectName,
  );
}

function toValidPackageName(projectName: string) {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]/, '')
    .replace(/[^a-z\d\-~]+/g, '-');
}

function pkgFromUserAgent(userAgent: string | undefined) {
  if (!userAgent) return undefined;
  const pkgSpec = userAgent.split(' ')[0];
  const pkgSpecArr = pkgSpec.split('/');
  return {
    name: pkgSpecArr[0],
    version: pkgSpecArr[1],
  };
}

// function emptyDir(dir: string) {
//   if (!fs.existsSync(dir)) {
//     return;
//   }
//   for (const file of fs.readdirSync(dir)) {
//     if (file === '.git') {
//       continue;
//     }
//     fs.rmSync(path.resolve(dir, file), { recursive: true, force: true });
//   }
// }

const FRAMEWORKS: Framework[] = [
  {
    name: '1',
    color: (name) => name + '',
    display: '1',
    variants: [{ name: '1-1', color: (s) => `${s}`, display: '1-1' }],
  },
];
const TEMPLATES: string[] = [];
const defaultTargetDir = 'new-project';

function getRegistryUrl() {
  return registryUrl();
}

async function searchTemplate() {
  const registryUrl = getRegistryUrl();
  const result = await axios.get(
    `${registryUrl}-/v1/search?text=@any-tools&size=100`,
  );
  console.log('=>(index.ts:95) result', result);
}

async function init() {
  const argTargetDir = formatTargetDir(argv._[0]);
  const argTemplate = argv.template || argv.t;

  let targetDir = argTargetDir || defaultTargetDir;
  const getProjectName = () =>
    targetDir === '.' ? path.basename(path.resolve()) : targetDir;

  await searchTemplate();

  let result: prompts.Answers<
    'projectName' | 'overwrite' | 'packageName' | 'framework' | 'variant'
  >;
  try {
    result = await prompts(
      [
        {
          type: argTargetDir ? null : 'text',
          name: 'projectName',
          initial: defaultTargetDir,
          message: chalk.reset('Project name:'),
          onState(state) {
            targetDir = formatTargetDir(state.value) || defaultTargetDir;
          },
        },
        {
          type: () => {
            return !fs.existsSync(targetDir) || isEmpty(targetDir)
              ? null
              : 'select';
          },
          name: 'overwrite',
          message: () =>
            (targetDir === '.'
              ? 'Current directory'
              : `Target directory "${targetDir}"`) +
            ` is not empty. Please choose how to proceed:`,
          initial: 0,
          choices: [
            {
              title: 'Remove existing files and continue',
              value: 'yes',
            },
            {
              title: 'Cancel operation',
              value: 'no',
            },
            {
              title: 'Ignore files and continue',
              value: 'ignore',
            },
          ],
        },
        {
          type: (_, { overwrite }: { overwrite?: string }) => {
            if (overwrite === 'no') {
              throw new Error(chalk.red('✖') + ' Operation cancelled');
            }
            return null;
          },
          name: 'overwriteChecker',
        },
        {
          type: () => (isValidPackageName(getProjectName()) ? null : 'text'),
          name: 'packageName',
          message: chalk.reset('Package name:'),
          initial: () => toValidPackageName(getProjectName()),
          validate: (dir) =>
            isValidPackageName(dir) || 'Invalid package.json name',
        },
        {
          type:
            argTemplate && TEMPLATES.includes(argTemplate) ? null : 'select',
          name: 'framework',
          message:
            typeof argTemplate === 'string' && !TEMPLATES.includes(argTemplate)
              ? chalk.reset(
                  `"${argTemplate}" isn't a valid template. Please choose from below: `,
                )
              : chalk.reset('Select a framework:'),
          initial: 0,
          choices: FRAMEWORKS.map((framework) => {
            const frameworkColor = framework.color;
            return {
              title: frameworkColor(framework.display || framework.name),
              value: framework,
            };
          }),
        },
        {
          type: (framework: Framework) => {
            return framework && framework.variants ? 'select' : null;
          },
          name: 'variant',
          message: chalk.reset('Select a variant:'),
          choices: (framework: Framework) =>
            framework.variants.map((variant) => {
              const variantColor = variant.color;
              return {
                title: variantColor(variant.display || variant.name),
                value: variant.name,
              };
            }),
        },
      ],
      {
        onCancel: () => {
          throw new Error(chalk.red('✖') + ' Operation cancelled');
        },
      },
    );
  } catch (cancelled: any) {
    console.log(cancelled.message);
    return;
  }

  const { overwrite } = result as Record<
    'projectName' | 'overwrite' | 'packageName' | 'framework' | 'variant',
    string
  >;
  // const { framework, overwrite, packageName, variant } = result;

  const root = path.join(cwd, targetDir);

  if (overwrite === 'yes') {
    // @eslint-disable @typescript-eslint/no-explicit-any
    // emptyDir(root);
  } else if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  const pkgInfo = pkgFromUserAgent(process.env.npm_config_user_agent);
  const pkgManager = pkgInfo ? pkgInfo.name : 'npm';
  const isYarn1 = pkgManager === 'yarn' && pkgInfo?.version.startsWith('1.');
  console.log('=>(index.ts:219) isYarn1', isYarn1);

  console.log(`\nScaffolding project in ${root}...`);
}

init().catch();
