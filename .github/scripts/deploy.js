const https = require('https');
const fs = require('fs');
const path = require('path');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_THEME_TOKEN;
const THEME_ID = process.env.SHOPIFY_THEME_ID;
const API_VERSION = '2024-04';

const TEXT_EXTS = new Set(['.liquid', '.json', '.css', '.js', '.txt', '.md', '.html', '.svg', '.yaml', '.yml']);
const THEME_DIRS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function uploadAsset(key, content, isBase64) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      asset: isBase64 ? { key, attachment: content } : { key, value: content }
    });

    const options = {
      hostname: STORE,
      path: `/admin/api/${API_VERSION}/themes/${THEME_ID}/assets.json`,
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(key);
        } else {
          reject(new Error(`${res.statusCode} uploading ${key}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function collectFiles() {
  const files = [];
  for (const dir of THEME_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(dir);
  }
  return files;
}

async function deploy() {
  if (!STORE || !TOKEN || !THEME_ID) {
    console.error('Missing SHOPIFY_STORE, SHOPIFY_THEME_TOKEN, or SHOPIFY_THEME_ID');
    process.exit(1);
  }

  const files = collectFiles();
  console.log(`Deploying ${files.length} files to ${STORE} theme ${THEME_ID}...`);

  let success = 0, failed = 0;

  for (const filePath of files) {
    const key = filePath.replace(/\\/g, '/');
    const ext = path.extname(filePath).toLowerCase();
    try {
      const buffer = fs.readFileSync(filePath);
      if (TEXT_EXTS.has(ext)) {
        await uploadAsset(key, buffer.toString('utf8'), false);
      } else {
        await uploadAsset(key, buffer.toString('base64'), true);
      }
      console.log(`✓ ${key}`);
      success++;
      await sleep(300);
    } catch (err) {
      console.error(`✗ ${key}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} uploaded, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

deploy();
