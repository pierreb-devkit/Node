import fs from 'fs/promises';
import path from 'path';

const fileName = path.resolve('./modules/auth/tests/auth.integration.tests.js');

const replacements = {
  aaaa: 'bbb',
};

const replaceStringsInFile = async (fileName, replacements) => {
  try {
    // Lire le fichier
    const data = await fs.readFile(fileName, 'utf8');

    // Remplacer les chaînes
    let result = data;
     
    for (const [oldString, newString] of Object.entries(replacements)) {
      const regex = new RegExp(oldString, 'g');
      result = result.replace(regex, newString);
    }

    // Enregistrer le fichier
    await fs.writeFile(fileName, result, 'utf8');
  } catch (err) {
    console.log(err);
  }
};

replaceStringsInFile(fileName, replacements);
