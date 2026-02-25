const fs = require('fs');
let content = fs.readFileSync('src/index.ts', 'utf8');

content = content.replace(/\{\s*error:\s*(.*?)\s*\}/g, "{ code: 1, message: $1 }");

fs.writeFileSync('src/index.ts', content);
