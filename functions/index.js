const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');

initializeApp();

const app = require('./server');

// 서울 리전, 스트리밍 해설 때문에 타임아웃 300초
exports.api = onRequest(
  { region: 'asia-northeast3', timeoutSeconds: 300, memory: '256MiB', invoker: 'public' },
  app
);
