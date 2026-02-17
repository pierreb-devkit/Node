import path from 'path';
import inquirer from 'inquirer';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const hasFlag = (flag) => process.argv.includes(flag);
const isCi = `${process.env.CI || ''}`.toLowerCase() === 'true';
const skipConfirmation = hasFlag('--yes') || isCi;

let services;

const getServices = async () => {
  if (!services) {
    const [{ default: config }, { default: mongooseService }] = await Promise.all([
      import('../config/index.js'),
      import('../lib/services/mongoose.js'),
    ]);
    services = { config, mongooseService };
  }

  return services;
};

const confirmDrop = async () => {
  if (process.env.NODE_ENV === 'test' || skipConfirmation) return true;

  const question = [
    {
      type: 'confirm',
      name: 'continue',
      message: `Do you really want to drop DB in ${process.env.NODE_ENV} ENV? (no)`,
      default: false,
    },
  ];

  const answer = await inquirer.prompt(question);
  return answer.continue;
};

const dropMongo = async () => {
  const { mongooseService } = await getServices();
  const db = await mongooseService.connect();
  try {
    const dropped = await db.connection.dropDatabase();
    if (dropped) console.log('Successfully dropped db:', db.connections[0].name);
    else console.log('DB drop failed');
  } finally {
    await mongooseService.disconnect();
  }
};

const dropDB = async () => {
  const confirmed = await confirmDrop();
  if (!confirmed) {
    console.log('Drop cancelled.');
    return false;
  }

  await dropMongo();
  return true;
};

const seedMongoose = async () => {
  const { mongooseService } = await getServices();
  await mongooseService.connect();
  try {
    await mongooseService.loadModels();
    const AuthService = await import(path.resolve('./modules/auth/services/auth.service.js'));
    const UserService = await import(path.resolve('./modules/users/services/users.service.js'));
    const TaskService = await import(path.resolve('./modules/tasks/services/tasks.service.js'));
    const seed = await import(path.resolve('./lib/services/seed.js'));

    await seed.default.start({ logResults: true }, UserService.default, AuthService.default, TaskService.default);
  } finally {
    await mongooseService.disconnect();
  }
};

const seedMongooseUser = async () => {
  const { config, mongooseService } = await getServices();
  await mongooseService.connect();
  try {
    await mongooseService.loadModels();
    const AuthService = await import(path.resolve('./modules/auth/services/auth.service.js'));
    const UserService = await import(path.resolve('./modules/users/services/users.service.js'));
    const seed = await import(path.resolve('./lib/services/seed.js'));

    await seed.default.user(config.seedDB.options.seedUser, UserService.default, AuthService.default);
    await seed.default.user(config.seedDB.options.seedAdmin, UserService.default, AuthService.default);
  } finally {
    await mongooseService.disconnect();
  }
};

const usage = () => {
  console.log('Usage: node scripts/seed.js <seed|seed:user|drop> [--yes]');
};

const main = async () => {
  const command = process.argv[2];

  if (command === 'seed') {
    const dropped = await dropDB();
    if (!dropped) process.exitCode = 2;
    else await seedMongoose();
    return;
  }

  if (command === 'seed:user') {
    await seedMongooseUser();
    return;
  }

  if (command === 'drop') {
    const dropped = await dropDB();
    if (!dropped) process.exitCode = 2;
    return;
  }

  usage();
  process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
