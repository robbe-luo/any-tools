import minimist from 'minimist';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import registryUrl from 'registry-url';
import { request } from 'urllib';
import { fileURLToPath } from 'node:url';
import compressing from 'compressing';

// Avoids auto conversion to number of the project name by defining that the args
// non-associated with an option ( _ ) needs to be parsed as a string. See #4606
const argv = minimist<{
  t?: string;
  template?: string;
}>(process.argv.slice(2), { string: ['_'] });
const cwd = process.cwd();

type PackageInfo = {
  version: string;
  name: string;
};

function formatTargetDir(targetDir: string | undefined) {
  return targetDir?.trim().replace(/\/+$/g, '');
}

function isEmpty(path: string) {
  const files = fs.readdirSync(path);
  return files.length === 0 || (files.length === 1 && files[0] === '.git');
}

// function isValidPackageName(projectName: string) {
//   return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(
//     projectName,
//   );
// }
//
// function toValidPackageName(projectName: string) {
//   return projectName
//     .trim()
//     .toLowerCase()
//     .replace(/\s+/g, '-')
//     .replace(/^[._]/, '')
//     .replace(/[^a-z\d\-~]+/g, '-');
// }

function pkgFromUserAgent(userAgent: string | undefined) {
  if (!userAgent) return undefined;
  const pkgSpec = userAgent.split(' ')[0];
  const pkgSpecArr = pkgSpec.split('/');
  return {
    name: pkgSpecArr[0],
    version: pkgSpecArr[1],
  };
}

function emptyDir(dir: string) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const file of fs.readdirSync(dir)) {
    if (file === '.git') {
      continue;
    }
    fs.rmSync(path.resolve(dir, file), { recursive: true, force: true });
  }
}

const defaultTargetDir = 'new-project';

function getRegistryUrl() {
  return registryUrl();
}

async function getPackageDetail(packageInfo: PackageInfo) {
  const registryUrl = getRegistryUrl();
  const result = await request(
    `${registryUrl}/${packageInfo.name}/${packageInfo.version}`,
    {
      method: 'GET',
      dataType: 'json',
    },
  );
  return result.data;
}

async function downloadBoilerplate(packageInfo: PackageInfo) {
  const result = await getPackageDetail(packageInfo as unknown as PackageInfo);
  const tgzUrl = result.dist.tarball;

  // const saveDir = path.join(os.tmpdir(), 'create-any-tools-boilerplate');
  const saveDir = path.join(
    fileURLToPath(new URL('.', import.meta.url)),
    'create-any-tools-boilerplate',
  );
  if (fs.existsSync(saveDir)) {
    fs.rmSync(saveDir);
  }

  fs.mkdirpSync(saveDir);

  const response = await request(tgzUrl, {
    streaming: true,
    followRedirect: true,
  });
  await compressing.tgz.uncompress(response.res as any, saveDir);

  return path.join(saveDir, 'package');
}

async function askForVariable(targetDir: string, templateDir: string) {
  let questions: any;

  try {
    console.log('=>(index.ts:117) templateDir', templateDir);
    questions = await import(`${templateDir}`);
    console.log('=>(index.ts:118) questions', questions);

    if (typeof questions === 'function') {
      questions = questions();
    }
    // use target dir name as `name` default
    if (questions?.name?.default) {
      questions.name.default = path.basename(targetDir);
    }
  } catch (err: any) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.log(
        chalk.yellow(
          `load boilerplate config got trouble, skip and use defaults, ${err.message}`,
        ),
      );
    }
    return {};
  }

  const keys = Object.keys(questions);

  return prompts(
    keys.map((key) => {
      const question = questions[key] as prompts.PromptObject<any>;
      console.log('=>(index.ts:137) question', question);
      return {
        name: question.name,
        type: question.type || 'text',
      };
    }),
  );
}

async function processFiles(targetDir: string, templateDir: string) {
  const src = path.join(templateDir, 'boilerplate');
  await askForVariable(targetDir, templateDir);
  console.log('=>(index.ts:104) src', src);
}

async function searchTemplate(): Promise<PackageInfo[]> {
  const registryUrl = getRegistryUrl();
  const result = await request(
    `${registryUrl}-/v1/search?text=@any-tools&size=100`,
    {
      dataType: 'json',
      headers: {
        'content-type': 'application/json',
      },
      method: 'GET',
    },
  );
  return result.data.objects.map((item: any) => {
    return {
      name: item.package.name,
      version: item.package.version,
    };
  });
}

async function init() {
  const argTargetDir = formatTargetDir(argv._[0]);
  const frameworks = await searchTemplate();
  let targetDir = argTargetDir || defaultTargetDir;

  let result: prompts.Answers<'projectName' | 'overwrite' | 'framework'>;
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
          type: 'select',
          name: 'framework',
          message: chalk.reset('Select a framework:'),
          initial: 0,
          choices: frameworks.map((framework) => {
            return {
              title: `${framework.name}@${framework.version}`,
              value: framework,
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

  const { overwrite, framework } = result as Record<
    'projectName' | 'overwrite' | 'framework',
    string
  >;
  const root = path.join(cwd, targetDir);

  if (overwrite === 'yes') {
    emptyDir(root);
  } else if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  const templateDir = await downloadBoilerplate(
    framework as unknown as PackageInfo,
  );
  const files = await processFiles(targetDir, templateDir);
  console.log('=>(index.ts:206) xDir', files);

  const pkgInfo = pkgFromUserAgent(process.env.npm_config_user_agent);
  const pkgManager = pkgInfo ? pkgInfo.name : 'npm';
  const isYarn1 = pkgManager === 'yarn' && pkgInfo?.version.startsWith('1.');
  console.log('=>(index.ts:219) isYarn1', isYarn1);

  console.log(`\nScaffolding project in ${root}...`);
}

init().catch();
