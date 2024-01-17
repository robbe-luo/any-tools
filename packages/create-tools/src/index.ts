import minimist from 'minimist';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import registryUrl from 'registry-url';
import { request } from 'urllib';
import { fileURLToPath } from 'node:url';
import compressing from 'compressing';
import glob from 'fast-glob';
import * as istextorbinary from 'istextorbinary';
import debug from 'debug';
import ora from 'ora';

const logger = debug('create-any-tools');
const spinner = ora('Loading unicorns').start();

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
    fs.removeSync(saveDir);
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
    questions = await import(`${templateDir}/index.js`).then(
      (m) => m?.default || m,
    );

    if (typeof questions === 'function') {
      questions = questions();
    }
    // use target dir name as `name` default
    if (!questions.name?.initial) {
      questions.name.initial = path.basename(targetDir);
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
      return {
        ...question,
        name: question.name || key,
        type: question.type || 'text',
        message: question.message || '',
        initial: question.initial,
      };
    }),
    {
      onCancel: () => {
        console.log('exit');
        process.exit(1);
      },
    },
  );
}

const fileMapping = {
  gitignore: '.gitignore',
  _gitignore: '.gitignore',
  '_.gitignore': '.gitignore',
  '_package.json': 'package.json',
  '_.eslintrc': '.eslintrc',
  '_.eslintignore': '.eslintignore',
  '_.npmignore': '.npmignore',
};

function replaceTemplate(content: string, scope: Record<string, any>) {
  return content
    .toString()
    .replace(/(\\)?{{ *(\w+) *}}/g, (block, skip, key) => {
      if (skip) {
        return block.substring(skip.length);
      }
      return scope?.[key] || block;
    });
}

async function processFiles(targetDir: string, templateDir: string) {
  const src = path.join(templateDir, 'boilerplate');
  const locals = await askForVariable(targetDir, templateDir);
  const files = glob.sync('**/*', {
    cwd: src,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
  });
  files.forEach((file) => {
    const { dir: dirname, base: basename } = path.parse(file);
    const from = path.join(src, file);
    const fileName =
      fileMapping[basename as keyof typeof fileMapping] || basename;
    const to = path.join(targetDir, dirname, replaceTemplate(fileName, locals));

    const stats = fs.lstatSync(from);
    if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      fs.symlinkSync(target, to);
      logger('%s link to %s', to, target);
    } else if (stats.isDirectory()) {
      fs.mkdirpSync(to);
    } else if (stats.isFile()) {
      const content = fs.readFileSync(from);
      logger('write to %s', to);

      // check if content is a text file
      // @ts-ignore
      const result = istextorbinary.isText(from, content)
        ? replaceTemplate(content.toString('utf8'), locals)
        : content;
      fs.writeFileSync(to, result);
    } else {
      console.log('ignore %s only support file, dir, symlink', file);
    }
  });
  return files;
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

function printUsage(targetDir: string) {
  console.log(`usage:
      - cd ${targetDir}
      - npm install
      - npm start
    `);
}

async function init() {
  const argTargetDir = formatTargetDir(argv._[0]);
  spinner.text = 'search npm template ...';
  const frameworks = await searchTemplate();
  spinner.stop();
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

  spinner.start('download npm template ...');

  const templateDir = await downloadBoilerplate(
    framework as unknown as PackageInfo,
  );
  spinner.text = `\nScaffolding project in ${root} ...`;

  spinner.stop();
  await processFiles(targetDir, templateDir);

  const cdProjectName = path.relative(cwd, root);

  printUsage(cdProjectName);
}

init().catch();
