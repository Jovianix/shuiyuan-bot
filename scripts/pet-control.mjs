import { request } from 'node:http';
const [command = 'status', argument] = process.argv.slice(2);
const paths = {status: '/status', tasks: '/tasks', task: `/tasks/${argument}`, draft: `/draft/${argument}`, retry: `/retry/${argument}`,
  pause: '/pause', resume: '/resume', scan: '/scan', reconcile: '/reconcile'};
if (!(command in paths)) throw new Error('Use status, tasks, task ID, draft POST_ID, retry TASK_ID (draft only), pause, resume, scan, or reconcile');
const req = request({socketPath: process.env.PET_CONTROL_SOCKET ?? '/data/pet/control.sock', path: paths[command],
  method: ['status','tasks','task'].includes(command) ? 'GET' : 'POST'}, res => {
  let text = '';
  res.setEncoding('utf8').on('data', chunk => { text += chunk; });
  res.on('end', () => { console.log(JSON.stringify(JSON.parse(text), null, 2)); if (res.statusCode !== 200) process.exitCode = 1; });
});
req.setTimeout(5000, () => req.destroy(new Error('Control socket timed out')));
req.on('error', error => { console.error(error.message); process.exitCode = 1; });
req.end();
