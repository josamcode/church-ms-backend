const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { google } = require('googleapis');
const config = require('../../config/env');

const GOOGLE_DRIVE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/drive.file';

class GoogleDriveService {
  constructor() {
    this.driveClientPromise = null;
  }

  async _readJsonFile(filePath) {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  async _loadOAuthClientConfig() {
    const payload = await this._readJsonFile(config.backup.googleDrive.oauthClientFilePath);
    const credentials = payload.installed || payload.web;

    if (!credentials?.client_id || !credentials?.client_secret) {
      throw new Error(
        `Google OAuth client file is invalid: ${config.backup.googleDrive.oauthClientFilePath}`
      );
    }

    if (!Array.isArray(credentials.redirect_uris) || credentials.redirect_uris.length === 0) {
      throw new Error(
        `Google OAuth client file must include at least one redirect URI: ${config.backup.googleDrive.oauthClientFilePath}`
      );
    }

    return credentials;
  }

  _createOAuthClient(credentials) {
    return new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uris[0]
    );
  }

  _normalizeAuthorizationCode(input) {
    const trimmed = String(input || '').trim();
    if (!trimmed) {
      throw new Error('No authorization code was provided.');
    }

    try {
      const parsedUrl = new URL(trimmed);
      const codeFromUrl = parsedUrl.searchParams.get('code');
      if (codeFromUrl) {
        return codeFromUrl;
      }
    } catch (error) {
      // If input is not a URL, treat it as the raw code.
    }

    return trimmed;
  }

  _mergeTokenData(existingToken = {}, nextToken = {}) {
    return Object.fromEntries(
      Object.entries({
        ...existingToken,
        ...nextToken,
      }).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );
  }

  async _readSavedToken() {
    return this._readJsonFile(config.backup.googleDrive.oauthTokenFilePath);
  }

  async _writeToken(tokenPayload) {
    await fsPromises.mkdir(path.dirname(config.backup.googleDrive.oauthTokenFilePath), {
      recursive: true,
    });
    await fsPromises.writeFile(
      config.backup.googleDrive.oauthTokenFilePath,
      JSON.stringify(tokenPayload, null, 2),
      'utf8'
    );
  }

  async getAuthorizationUrl() {
    const credentials = await this._loadOAuthClientConfig();
    const oauthClient = this._createOAuthClient(credentials);

    return oauthClient.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [GOOGLE_DRIVE_UPLOAD_SCOPE],
    });
  }

  async authorizeWithCodeInput(codeInput) {
    const credentials = await this._loadOAuthClientConfig();
    const oauthClient = this._createOAuthClient(credentials);
    const code = this._normalizeAuthorizationCode(codeInput);
    const tokenResponse = await oauthClient.getToken(code);
    const tokens = tokenResponse.tokens || {};

    if (!tokens.refresh_token) {
      throw new Error(
        'Google OAuth did not return a refresh token. Re-run authorization and approve consent again.'
      );
    }

    const mergedTokens = this._mergeTokenData({}, tokens);
    await this._writeToken(mergedTokens);
    oauthClient.setCredentials(mergedTokens);
    this.driveClientPromise = null;

    return {
      tokenFilePath: config.backup.googleDrive.oauthTokenFilePath,
      redirectUri: credentials.redirect_uris[0],
    };
  }

  async _createDriveClient() {
    const credentials = await this._loadOAuthClientConfig();
    const oauthClient = this._createOAuthClient(credentials);

    let savedToken;
    try {
      savedToken = await this._readSavedToken();
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `Google OAuth token file was not found at ${config.backup.googleDrive.oauthTokenFilePath}. Run the OAuth authorization script first.`
        );
      }

      throw error;
    }

    oauthClient.setCredentials(savedToken);
    await oauthClient.getAccessToken();
    await this._writeToken(this._mergeTokenData(savedToken, oauthClient.credentials));

    return google.drive({
      version: 'v3',
      auth: oauthClient,
    });
  }

  async _getDriveClient() {
    if (!this.driveClientPromise) {
      this.driveClientPromise = this._createDriveClient().catch((error) => {
        this.driveClientPromise = null;
        throw error;
      });
    }

    return this.driveClientPromise;
  }

  async uploadBackup({ fileName, filePath }) {
    const drive = await this._getDriveClient();
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [config.backup.googleDrive.folderId],
        description: `Automated MongoDB backup uploaded by ${config.site.name}`,
      },
      media: {
        mimeType: 'application/gzip',
        body: fs.createReadStream(filePath),
      },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });

    const uploadedFile = response.data || {};
    if (!uploadedFile.id) {
      throw new Error('Google Drive upload did not return a file id.');
    }

    return {
      id: uploadedFile.id,
      name: uploadedFile.name || fileName,
      webViewLink:
        uploadedFile.webViewLink || `https://drive.google.com/file/d/${uploadedFile.id}/view`,
    };
  }
}

module.exports = new GoogleDriveService();
