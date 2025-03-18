import * as dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';

const sourcePath = path.resolve('public/index.html');
const destDir = path.resolve('dist');
const destPath = path.join(destDir, 'index.html');

// Create 'dist' directory if it doesn't exist
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Read the source file
fs.readFile(sourcePath, 'utf8', (err, data) => {
  if (err) {
    console.error('Error reading the file:', err);
    return;
  }

  // Replace placeholders with environment variables
  const modifiedData = data.replace(/\${(.*?)}/g, (match, variableName) => {
    return process.env[variableName] || match; // Keep original if env var is not found
  });

  // Write the modified content to the destination file
  fs.writeFile(destPath, modifiedData, 'utf8', (err) => {
    if (err) {
      console.error('Error writing to the file:', err);
      return;
    }
    console.log('File copied and modified successfully!');
  });
});
