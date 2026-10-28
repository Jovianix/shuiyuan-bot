import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCall, activeText, quoteTargets, replyBody, replyText, AI_NOTE } from '../plugins/shuiyuan-pet/dist/trigger.js';
import { buildContext } from '../plugins/shuiyuan-pet/dist/context.js';
import { Store } from '../plugins/shuiyuan-pet/dist/store.js';
import { Activities } from '../plugins/shuiyuan-pet/dist/activities.js';
import { Discovery } from '../plugins/shuiyuan-pet/dist/discovery.js';
import { DshModel, extractAnswer } from '../plugins/shuiyuan-pet/dist/dsh.js';
import { ForumError, PermanentError } from '../plugins/shuiyuan-pet/dist/types.js';

const config = {
  site:'https://forum.invalid', owner:'owner', ownerId:10, petId:'fish', petName:'大肥鱼',
  mode:'draft', replyTopics:[77], relatedLimit:4, contextChars:12000, maxAttempts:3, catchUpMs:3*3_600_000,
  timeoutMs:2000, provider:'test', model:'test', maxTokens:200, workspace:'/tmp',
};
const post = (id=1, changes={}) => ({id, topic_id:77, post_number:id, user_id:20, username:'caller',
  raw:'@owner 【大肥鱼】为什么天空是蓝色的？', created_at:new Date().toISOString(), updated_at:'v1',
  post_type:1, archetype:'regular', ...changes});
function fixture(t, options={}) {
  const dir=mkdtempSync(join(tmpdir(),'pet-test-'));
  const store=new Store(join(dir,'state.sqlite'),config.site,config.petId);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let sends=0,generations=0;
  const source=post();
  // readPost(floor) is a test knob for what the forum currently holds; locate and readAround
  // are the real interface built on it, and every call to them counts as one request.
  const forum={readPost:async()=>source,
    actions:async()=>[],recentOwnPosts:async()=>[],send:async(topic,parent,raw)=>{
      sends++;return post(99,{topic_id:topic,reply_to_post_number:parent,raw,user_id:10,username:'owner'});
    },close:async()=>{},...options.forum};
  let reads=0;
  forum.locate??=async id=>{reads++;const p=await forum.readPost(id);return {id:p.id,topic_id:p.topic_id,post_number:p.post_number,raw:p.raw};};
  forum.readAround??=async(topic,floor)=>{reads++;const p=await forum.readPost(floor);
    return [p.topic_id===topic&&p.post_number===floor?p:post(floor,{topic_id:topic})];};
  const model={generate:async(_context,sessionId)=>{generations++;return {text:'是空气散射了阳光。',sessionId,turn:1,soulHash:'hash'};},
    recover:async()=>undefined,...options.model};
  const cfg={...config,...options.config};
  const activities=new Activities(store,forum,model,cfg);
  return {store,forum,model,activities,source,cfg,dir,get sends(){return sends;},get generations(){return generations;},get reads(){return reads;}};
}
const signal=()=>new AbortController().signal;

test('only `@owner 【pet】` invokes, for other users and the owner alike',()=>{
  assert.equal(isCall(post(),config),true);
  assert.equal(isCall(post(1,{raw:'@owner 【大肥鱼】嗨',user_id:10}),config),true);
  assert.equal(isCall(post(1,{raw:'[quote="a, post:3"]\n前文\n[/quote]\n\n补充 @owner【大肥鱼】怎么看'}),config),true);
  assert.equal(isCall(post(1,{raw:'@OWNER\n【大肥鱼】'}),config),true);
  for(const raw of ['【大肥鱼】嗨','@owner 嗨','@owner 看看【大肥鱼】','@owner_other 【大肥鱼】','a@owner 【大肥鱼】'])
    assert.equal(isCall(post(1,{raw,user_id:10}),config),false,raw);
});
test('quoted, code, URLs and HTML content cannot wake the pet',()=>{
  for(const raw of [
    '> @owner 【大肥鱼】', '[quote="x, post:5"]@owner 【大肥鱼】[/quote]',
    '[quote="x"]nested [quote="y"]@owner 【大肥鱼】[/quote][/quote]',
    '[quote="x"]@owner 【大肥鱼】', '```text\n@owner 【大肥鱼】\n```',
    '    @owner 【大肥鱼】', '`@owner 【大肥鱼】`',
    '[link](https://example.invalid/@owner/【大肥鱼】)', '<span>@owner 【大肥鱼】</span>',
    '<!-- @owner 【大肥鱼】 -->',
  ]) assert.equal(isCall(post(1,{raw}),config),false,raw);
  assert.equal(isCall(post(1,{raw:'[quote="x"]@owner 【大肥鱼】[/quote]\n@owner 【大肥鱼】hi'}),config),true);
  assert.ok(activeText('hello <br> @owner 【大肥鱼】').includes('@owner'));
  assert.equal(isCall(post(1,{raw:'`[quote="example"]` @owner 【大肥鱼】hi'}),config),true);
});
test('hidden, deleted, system posts and private messages are excluded',()=>{
  for(const patch of [{hidden:true},{deleted_at:'today'},{post_type:2},{archetype:'private_message'}]) assert.equal(isCall(post(1,patch),config),false);
});
test('explicit quote references support remote topics and ignore code',()=>{
  assert.deepEqual(quoteTargets('[quote="a, post:4, topic:88"]x[/quote]\n[quote="b, post:3"]x[/quote]\n```\n[quote="c, post:6"]\n```',77),[
    {topic:88,floor:4},{topic:77,floor:3},
  ]);
});
test('context takes exact parent and quote once, reuses the window, marks wrong/missing floors',async()=>{
  const calls=[];
  const source=post(8,{reply_to_post_number:2,raw:'[quote="a, post:2, topic:77"]x[/quote]\n[quote="b, post:4, topic:88"]y[/quote]'});
  const forum={readAround:async(topic,floor)=>{calls.push([topic,floor]);return [post(topic===88?5:floor,{topic_id:topic})];}};
  const pack=await buildContext(source,[source],forum,config);
  assert.deepEqual(calls,[[77,2],[88,4]]);
  assert.equal(pack.related.length,1);assert.deepEqual(pack.missing,['88/4: unavailable']);
  // A parent already in the window around the source costs no request.
  calls.length=0;await buildContext(source,[post(2),source],forum,config);assert.deepEqual(calls,[[88,4]]);
});
test('context obeys one combined character budget and reports truncation',async()=>{
  const pack=await buildContext(post(8,{raw:'12345',reply_to_post_number:2}),[],{readAround:async()=>[post(2,{raw:'abcdef'})]},{...config,contextChars:8});
  assert.equal(pack.related[0].raw,'abc');assert.deepEqual(pack.truncated,[2]);
});
test('two discovery origins and edits retain one durable task',t=>{
  const f=fixture(t);const a=f.store.enqueue(1,'draft','mentions');
  assert.equal(f.store.enqueue(1,'reply','owner'),a);assert.equal(f.store.task(a).mode,'draft');
  assert.equal(f.store.list().length,1);
});
test('slow generation does not block discovery and serial worker cannot double-generate',async t=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{model:{generate:async(_,sessionId)=>{await blocked;return {text:'answer',sessionId,turn:1,soulHash:'hash'};}}});
  f.store.enqueue(1,'draft','mentions');const run=f.activities.tick(signal());
  await new Promise(resolve=>setImmediate(resolve));await f.activities.tick(signal());
  const discovery=new Discovery(f.store,f.forum,f.cfg);f.store.setMeta('scan',{baseline:0,seen:[]});
  f.forum.readPost=async floor=>floor===2?post(2):f.source;
  f.forum.actions=async()=>[{post_id:2,topic_id:77,post_number:2,created_at:new Date(Date.now()+1000).toISOString()}];
  await discovery.scan();assert.equal(f.store.list().length,2);
  release();await run;assert.equal(f.store.list('draft_ready').length,1);
});
test('switching config to reply never sends draft-mode backlog',async t=>{
  const f=fixture(t,{config:{mode:'reply'}});const id=f.store.enqueue(1,'draft','mentions');
  await f.activities.tick(signal());await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'draft_ready');assert.equal(f.sends,0);
});
test('reply sends to fixed source floor and excludes the outgoing post',async t=>{
  const f=fixture(t,{config:{mode:'reply'}});const id=f.store.enqueue(1,'reply','mentions');
  await f.activities.tick(signal());await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'sent');assert.equal(f.sends,1);assert.equal(f.store.task(id).sent_id,99);
  f.forum.readPost=async()=>post(99,{user_id:10,raw:f.store.task(id).answer.text});const own=f.store.enqueue(99,'reply','owner');
  await f.activities.tick(signal());assert.equal(f.store.task(own).state,'skipped');
});
test('removed invocation cancels queued work and edited source cancels send',async t=>{
  const f=fixture(t,{config:{mode:'reply'}});const id=f.store.enqueue(1,'reply','mentions');
  await f.activities.tick(signal());f.source.raw='changed';await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'skipped');assert.equal(f.sends,0);
  const second=f.store.enqueue(2,'reply','owner');await f.activities.tick(signal());
  assert.equal(f.store.task(second).state,'skipped');
});

test('a truncated source can be sent only while its full original body is unchanged',async t=>{
  const f=fixture(t,{config:{mode:'reply',contextChars:10}});const id=f.store.enqueue(1,'reply','mentions');
  await f.activities.tick(signal());assert.equal(f.store.task(id).context.source.raw.length,10);
  await f.activities.tick(signal());assert.equal(f.store.task(id).state,'sent');
});
test('response loss records unknown and never blindly sends again; one exact match reconciles',async t=>{
  let sent;let calls=0;
  const f=fixture(t,{config:{mode:'reply'},forum:{send:async(topic,parent,raw)=>{
    calls++;sent=post(99,{topic_id:topic,reply_to_post_number:parent,raw,user_id:10});throw Error('response lost');
  }}});
  const id=f.store.enqueue(1,'reply','mentions');await f.activities.tick(signal());await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'delivery_unknown');await f.activities.tick(signal());assert.equal(calls,1);
  await f.activities.reconcile();assert.equal(f.store.task(id).state,'delivery_unknown');
  f.forum.recentOwnPosts=async()=>[sent,{...sent,id:100}];await f.activities.reconcile();assert.equal(f.store.task(id).state,'delivery_unknown');
  f.forum.recentOwnPosts=async()=>[sent];await f.activities.reconcile();assert.equal(f.store.task(id).state,'sent');assert.equal(calls,1);
});
test('reconcile rejects wrong author, target, body or time',async t=>{
  const f=fixture(t,{config:{mode:'reply'}});const id=f.store.enqueue(1,'reply','mentions');await f.activities.tick(signal());
  f.store.update(id,{state:'delivery_unknown',send_started:Date.now()});const task=f.store.task(id);
  const candidate=post(99,{user_id:10,reply_to_post_number:1,raw:task.answer.text});
  for(const patch of [{user_id:20},{reply_to_post_number:2},{raw:'different'},{created_at:'2000-01-01'},{topic_id:88}]) assert.equal(f.activities.matchesDelivery(task,{...candidate,...patch}),false);
});
test('posted replies carry the AI note and a random hidden tag, and never wake the pet',async t=>{
  const a=replyText(replyBody('@owner 【大肥鱼】来了　\n','大肥鱼')),b=replyText('@owner 大肥鱼来了');
  assert.ok(a.startsWith(`@owner 大肥鱼来了\n\n${AI_NOTE}\n\n<!-- shuiyuan-pet `));assert.notEqual(a,b);
  // The tag alone identifies the pet's own post, whatever its wording.
  assert.equal(isCall(post(2,{user_id:10,raw:replyText('@owner 【大肥鱼】在吗')}),config),false);
  let generations=0;
  const f=fixture(t,{config:{mode:'reply'},model:{generate:async(_c,sessionId)=>{generations++;return {text:'@owner 【大肥鱼】我来啦',sessionId,turn:1,soulHash:'h'};}},
    forum:{send:async()=>{throw Error('response lost');}}});
  const id=f.store.enqueue(1,'reply','mentions');await f.activities.tick(signal());await f.activities.tick(signal());
  const sent=f.store.task(id);assert.equal(sent.state,'delivery_unknown');
  // The unconfirmed reply then shows up in the owner's activity stream.
  f.forum.readPost=async()=>post(2,{user_id:10,raw:sent.answer.text,reply_to_post_number:1});
  const own=f.store.enqueue(2,'reply','owner');await f.activities.tick(signal());
  assert.equal(f.store.task(own).state,'skipped');assert.equal(generations,1);
});
test('each new activity costs one read, only invocations are stored, and generation reads nothing',async t=>{
  const f=fixture(t);f.store.setMeta('scan',{baseline:0,seen:[]});
  // Floor 3 is the parent of the invocation at floor 4, so one window read covers both.
  f.forum.readAround=async(topic,floor)=>{f.windowReads=(f.windowReads??0)+1;
    return floor===4?[post(3),post(4,{reply_to_post_number:3})]:[post(floor,{raw:'@owner 你看这个'})];};
  const at=(id,ago)=>({post_id:id,topic_id:77,post_number:id,created_at:new Date(Date.now()-ago).toISOString(),action_type:'mentions'});
  f.forum.actions=async()=>[at(4,1000),at(5,2000)];
  await new Discovery(f.store,f.forum,f.cfg).scan();
  assert.equal(f.windowReads,2);assert.deepEqual(f.store.list().map(t=>t.source_id),[4]);
  assert.equal(f.store.task(f.store.list()[0].id).context.related[0].post_number,3);
  await f.activities.tick(signal());assert.equal(f.store.list()[0].state,'draft_ready');assert.equal(f.windowReads,2);assert.equal(f.reads,0);
});
test('restart recovers completed DSH output and turns interrupted sends into unknown',async t=>{
  const f=fixture(t,{model:{recover:async sessionId=>({text:'recovered',sessionId,turn:1,soulHash:'hash'})}});
  const a=f.store.enqueue(1,'draft','mentions'),b=f.store.enqueue(2,'reply','mentions');
  f.store.update(a,{state:'generating',session_id:'durable-session',context:{source:post(1),related:[],missing:[],truncated:[],sourceHash:'h'}});f.store.update(b,{state:'sending'});
  await f.activities.recover();assert.ok(f.store.task(a).answer.text.startsWith('recovered\n\n'));assert.equal(f.store.task(b).state,'delivery_unknown');
  assert.equal(f.generations,0);assert.equal(f.sends,0);
});

test('retry reuses the stored context and a completed DSH result',async t=>{
  const f=fixture(t);const id=f.store.enqueue(1,'draft','mentions');await f.activities.tick(signal());
  const reads=f.reads;
  f.store.update(id,{state:'queued',answer:null});f.model.recover=async sessionId=>({text:'是空气散射了阳光。',sessionId,turn:1,soulHash:'hash'});
  await f.activities.tick(signal());assert.equal(f.generations,1);assert.ok(f.store.task(id).answer.text.startsWith('是空气散射了阳光。\n\n'));
  assert.equal(f.reads,reads);
});
test('generation failures back off and eventually yield to later tasks',async t=>{
  const f=fixture(t,{model:{generate:async()=>{throw Error('model down');}}});
  const id=f.store.enqueue(1,'draft','mentions');
  for(let i=0;i<3;i++){f.store.update(id,{available_at:0});await f.activities.tick(signal());}
  assert.equal(f.store.task(id).state,'failed');assert.equal(f.store.task(id).attempts,3);assert.equal(f.sends,0);
});
test('a permanent read failure skips instead of spending every retry',async t=>{
  const f=fixture(t,{forum:{readPost:async()=>{throw new PermanentError('Only regular forum topics are supported');}}});
  const id=f.store.enqueue(1,'draft','mentions');
  await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'skipped');assert.equal(f.store.task(id).attempts,0);
});
test('a rejected reply becomes one failure notice; a rejected notice fails; rate limiting waits',async t=>{
  const posted=[];
  const f=fixture(t,{config:{mode:'reply'},forum:{send:async(_t,_p,raw)=>{posted.push(raw);throw new ForumError('discourse_create_post failed (HTTP 422)',422,['Body is too short']);}}});
  const id=f.store.enqueue(1,'reply','mentions');await f.activities.tick(signal());await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'draft_ready');assert.equal(f.store.task(id).answer.notice,true);assert.match(f.store.task(id).error,/too short/);
  await f.activities.tick(signal());assert.equal(f.store.task(id).state,'failed');
  await f.activities.tick(signal());assert.equal(posted.length,2);assert.match(posted[1],/没能回复/);
  f.forum.send=async()=>{throw new ForumError('discourse_create_post failed (HTTP 429)',429);};
  const limited=f.store.enqueue(2,'reply','mentions');f.source.id=2;f.source.post_number=2;
  await f.activities.tick(signal());await f.activities.tick(signal());
  assert.equal(f.store.task(limited).state,'draft_ready');assert.ok(f.store.task(limited).available_at>Date.now());
});
test('a reply-mode invocation that cannot be generated is answered with one failure notice',async t=>{
  const f=fixture(t,{config:{mode:'reply'},model:{generate:async()=>{throw Error('model down');}}});
  const id=f.store.enqueue(1,'reply','mentions');
  for(let i=0;i<3;i++){f.store.update(id,{available_at:0});await f.activities.tick(signal());}
  assert.equal(f.store.task(id).answer.notice,true);
  await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'sent');assert.equal(f.sends,1);assert.match(f.store.task(id).error,/failure notice/);
});
test('a reply-mode invocation outside the allowlist is kept as a draft',async t=>{
  const f=fixture(t,{config:{mode:'reply',replyTopics:[88]}});const id=f.store.enqueue(1,'reply','mentions');
  await f.activities.tick(signal());await f.activities.tick(signal());
  assert.equal(f.store.task(id).state,'draft_ready');assert.equal(f.store.task(id).mode,'draft');assert.equal(f.sends,0);
});
const act=(id,ago=0,type='mentions')=>({post_id:id,topic_id:77,post_number:id,created_at:new Date(Date.now()-ago).toISOString(),action_type:type});
test('the first scan only records a baseline; later scans read only posts not on the previous page',async t=>{
  const f=fixture(t);f.forum.readPost=async floor=>post(floor,{raw:floor===3?'@owner 你看这个':'@owner 【大肥鱼】在吗'});
  let calls=0;let actions=[act(1,60_000)];f.forum.actions=async()=>{calls++;return actions;};
  const d=new Discovery(f.store,f.forum,f.cfg);await d.scan();
  assert.equal(calls,1);assert.equal(f.reads,0);assert.equal(f.store.list().length,0);
  actions=[act(3,0,'replies'),act(2),...actions];
  await d.scan();await d.scan();assert.equal(calls,3);assert.equal(f.reads,2);
  assert.deepEqual(f.store.list().map(t=>[t.source_id,t.origin]),[[2,'mentions']]);
});
test('a failed read is retried next scan; a gone or private post is not',async t=>{
  const f=fixture(t);f.store.setMeta('scan',{baseline:0,seen:[]});f.forum.readPost=async floor=>post(floor);
  let fail={2:new ForumError('timeout'),3:new PermanentError('private')};
  const around=f.forum.readAround;f.forum.readAround=async(topic,floor,limit)=>{
    if(fail[floor]){const e=fail[floor];if(floor===2)delete fail[2];throw e;}return around(topic,floor,limit);};
  f.forum.actions=async()=>[act(3),act(2)];
  const d=new Discovery(f.store,f.forum,f.cfg);await d.scan();assert.equal(f.store.list().length,0);
  await d.scan();assert.deepEqual(f.store.list().map(t=>t.source_id),[2]);
  await d.scan();assert.deepEqual(f.store.getMeta('scan').seen.sort(),[2,3]);
});
test('after long downtime discovery does not reach back past catchUpMs',async t=>{
  const f=fixture(t);const now=Date.now();
  f.store.setMeta('scan',{baseline:now-60*86_400_000,seen:[]});f.forum.readPost=async floor=>post(floor);
  f.forum.actions=async()=>[act(2,600_000),act(1,86_400_000)];
  await new Discovery(f.store,f.forum,f.cfg).scan();
  assert.deepEqual(f.store.list().map(t=>t.source_id),[2]);
});

test('full loop: a scanned invocation is answered once and the posted reply does not wake the pet',async t=>{
  const f=fixture(t,{config:{mode:'reply'}});
  // An in-memory topic 77 and the owner's activity stream over it.
  const floors=new Map([[1,post(1,{raw:'前文',user_id:30})]]),stream=[];
  const activity=(p,type)=>({post_id:p.id,topic_id:77,post_number:p.post_number,created_at:p.created_at,action_type:type});
  const add=(p,type)=>{floors.set(p.post_number,p);stream.unshift(activity(p,type));};
  let sends=0;
  Object.assign(f.forum,{actions:async()=>stream,
    readAround:async(_topic,floor)=>[...floors.values()].filter(p=>Math.abs(p.post_number-floor)<=5),
    locate:async id=>{const p=[...floors.values()].find(p=>p.id===id);return {id,topic_id:77,post_number:p.post_number,raw:p.raw};},
    send:async(_topic,parent,raw)=>{sends++;const p=post(floors.size+1,{id:100,raw,user_id:10,username:'owner',reply_to_post_number:parent});
      add(p,'replies');return p;}});
  const listener=new Discovery(f.store,f.forum,f.cfg);
  await listener.scan();
  add(post(2,{raw:'@owner 【大肥鱼】你怎么看',reply_to_post_number:1}),'mentions');
  await listener.scan();await f.activities.tick(signal());await f.activities.tick(signal());
  const [task]=f.store.list();
  assert.equal(task.state,'sent');assert.equal(task.sent_id,100);assert.equal(sends,1);
  assert.equal(task.context.related[0].post_number,1);assert.equal(floors.get(3).reply_to_post_number,2);
  await listener.scan();await f.activities.tick(signal());
  assert.equal(f.store.list().length,1);assert.equal(sends,1);
});

const events=()=>[
  {type:'turn/start',data:{turn:1}},
  {type:'system/message',data:{message:{content:[{type:'text',text:'你是大肥鱼。'}]}}},
  {type:'user/message',data:{id:'input',source:{kind:'user'}}},
  {type:'assistant/message',data:{turn:1,message:{content:[{type:'thinking',text:'secret reasoning'},{type:'text',text:'你好呀'}]}}},
  {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
];
test('final extraction requires matching completed turn and excludes reasoning',()=>{
  assert.equal(extractAnswer(events(),'session','input').text,'你好呀');
  assert.equal(extractAnswer(events().slice(0,-1),'session','input'),undefined);
  assert.equal(extractAnswer(events(),'session','other'),undefined);
  for(const kind of ['error','aborted','max-tokens','blocked']){const e=events();e.at(-1).data.reason.kind=kind;assert.equal(extractAnswer(e,'session'),undefined);}
  const e=events();e[3].data.interrupted=true;assert.equal(extractAnswer(e,'session'),undefined);
  assert.equal(extractAnswer([...events(),{type:'user/message',data:{id:'other',source:{kind:'user'}}}],'session'),undefined);
  const injected=events();injected.splice(3,0,{type:'user/message',data:{id:'runtime',source:{kind:'runtime-context'}}});
  assert.equal(extractAnswer(injected,'session','input').text,'你好呀');
});
test('DSH adapter restricts tools before prompt, flushes and disposes; reads recovery without resume',async()=>{
  const calls=[];let log=events();
  const ctx={agents:{create:async options=>{
    options.setup({tools:{restrict:v=>calls.push(['restrict',v]),guard:fn=>calls.push(['guard',fn()])}});
    assert.equal(options.meta.agentPreset,'pet');
    return {agent:{session:{id:options.sessionId,snapshotEvents:()=>log},
      followup:message=>{log[2].data.id=message.id;calls.push(['prompt']);},whenIdle:async()=>{},cancel:()=>{}},dispose:async()=>calls.push(['dispose'])};
  }},sessions:{flush:async()=>{calls.push(['flush']);return true;}},
    sessionPersistence:{stat:async()=>({}),open:async(_id,access)=>{assert.equal(access,'read');return {read:async()=>({events:log}),close:async()=>calls.push(['close-read'])};}}};
  const model=new DshModel(ctx,config);const result=await model.generate({source:post(),related:[],missing:[],truncated:[]},'session',signal());
  assert.equal(result.text,'你好呀');assert.deepEqual(calls.map(c=>c[0]),['restrict','guard','prompt','flush','dispose']);
  assert.deepEqual(calls[0][1],{allow:[]});assert.equal((await model.recover('session')).text,'你好呀');
});
