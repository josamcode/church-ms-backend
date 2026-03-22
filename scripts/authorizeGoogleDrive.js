const readline = require('readline/promises');
const { stdin, stdout } = require('process');

process.env.GOOGLE_OAUTH_ALLOW_MISSING_TOKEN = 'true';

const googleDriveService = require('../src/modules/backups/googleDrive.service');

const authorizeGoogleDrive = async () => {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const authUrl = await googleDriveService.getAuthorizationUrl();

    console.log('\nOpen this URL in your browser and authorize your Google account:\n');
    console.log(authUrl);
    console.log(
      '\nAfter Google redirects you, paste either the full redirected URL or just the "code" value below.\n'
    );

    const codeInput = await rl.question('Authorization code or redirected URL: ');
    const result = await googleDriveService.authorizeWithCodeInput(codeInput);

    console.log('\nGoogle Drive OAuth token saved successfully.');
    console.log(`Token file: ${result.tokenFilePath}`);
    console.log(`Redirect URI used: ${result.redirectUri}\n`);
  } catch (error) {
    console.error(`\nGoogle Drive authorization failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
};

authorizeGoogleDrive();
