import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';

const store = () => getStore({name:'rail-rivalry-v2', consistency:'strong', region:'eu-central-1'});
const HEADERS = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate','Access-Control-Allow-Origin':'*'};
const makeResponse = (data,status=200) => new Response(JSON.stringify(data),{status,headers:HEADERS});
const KEYCHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randRoom=()=>Array.from(randomBytes(6),v=>KEYCHARS[v%KEYCHARS.length]).join('');
const randToken=()=>randomBytes(24).toString('hex');
const valid=(str,n=80)=>typeof str==='string'&&str.length>0&&str.length<=n;
const getPhase=(s)=>s.phase==='question'&&Date.now()>=s.deadline?'reveal':s.phase;
const view=(s,uid,host)=>({room:s.room,phase:getPhase(s),idx:s.idx,deadline:s.deadline,revision:s.rev,players:Object.values(s.players).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).map(p=>({uid:p.uid,name:p.name,score:p.score,answered:s.answers[p.uid]!==undefined})),answersCount:Object.keys(s.answers).length,host, you:uid||null});
const questionCount=15;
const letters=(a)=>Number.isInteger(a)&&a>=0&&a<=3;
const answers=[1,2,3,0,1,2,0,3,2,0,1,3,1,2,0];
const publicData=(s,uid,host)=>({...view(s,uid,host), correct:(getPhase(s)==='reveal'||s.phase==='finished')?answers[s.idx]:null});
async function mutate(st,key,fn){
 for(let k=0;k<16;k++){
  const entry=await st.getWithMetadata(key,{type:'json',consistency:'strong'});
  if(!entry)return {status:404,error:'Room not found. Ask the host for a new link.'};
  const s=entry.data;
  const outcome=fn(s);
  if(outcome?.error)return {status:outcome.status||400,error:outcome.error};
  s.rev=(s.rev||0)+1;
  const write=await st.setJSON(key,s,{onlyIfMatch:entry.etag});
  if(write.modified)return {state:s,ok:true};
 }
 return {status:409,error:'Several players answered at once. Please try again.'};
}
export default async function handler(request){
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:HEADERS});
 if(!['POST','GET'].includes(request.method))return makeResponse({error:'Method not allowed'},405);
 let body={};
 try{body=request.method==='POST'?await request.json():Object.fromEntries(new URL(request.url).searchParams)}catch{return makeResponse({error:'Invalid request'},400)}
 const action=body.action||'state';
 const st=store();
 try{
  if(action==='health')return makeResponse({ok:true,backend:'Netlify Functions + Netlify Blobs',version:2});
  if(action==='create'){
   for(let i=0;i<12;i++){
    const room=randRoom(), token=randToken();
    const state={room,token,phase:'lobby',idx:-1,deadline:0,players:{},answers:{},rev:0,created:Date.now()};
    const r=await st.setJSON('room-'+room,state,{onlyIfNew:true});
    if(r.modified)return makeResponse({ok:true,room,token,...publicData(state,null,true)});
   }
   return makeResponse({error:'Could not allocate a room'},503);
  }
  if(!valid(body.room,6)||! /^[A-HJ-NP-Z2-9]{6}$/.test(body.room))return makeResponse({error:'Invalid six-character room code'},400);
  const key='room-'+body.room;
  if(action==='state'){
   const s=await st.get(key,{type:'json',consistency:'strong'});
   if(!s)return makeResponse({error:'Room not found. The host may need to create a new room.'},404);
   const isHost=body.token&&body.token===s.token;
   const uid=valid(body.uid,64)&&s.players[body.uid]?body.uid:null;
   return makeResponse({ok:true,...publicData(s,uid,isHost)});
  }
  const result=await mutate(st,key,s=>{
   const isHost=body.token===s.token&&valid(body.token,64);
   if(action==='join'){
    const uid=body.uid,name=(body.name||'').trim().replace(/[<>]/g,'').slice(0,18);
    if(!valid(uid,64)||!valid(name,18))return {error:'Please enter a valid player name'};
    if(!s.players[uid]&&Object.keys(s.players).length>=7)return {error:'The room is full (7 players).'};
    if(!s.players[uid]&&s.phase!=='lobby')return {error:'This game has already started.'};
    if(!s.players[uid])s.players[uid]={uid,name,score:0};
    else s.players[uid].name=name;
   }else if(action==='answer'){
    if(!valid(body.uid,64)||!s.players[body.uid])return {error:'Join the game first'};
    if(s.phase!=='question'||Date.now()>=s.deadline||s.idx!==body.idx)return {error:'This round has closed'};
    if(s.answers[body.uid]!==undefined)return {error:'Answer already submitted'};
    if(!letters(body.answer))return {error:'Invalid answer'};
    s.answers[body.uid]=body.answer;
    const rem=Math.max(0,s.deadline-Date.now());
    if(body.answer===answers[s.idx])s.players[body.uid].score+=1000+Math.round(500*rem/20000);
   }else{
    if(!isHost)return {status:403,error:'Only the host may control the game'};
    if(action==='start'){
     if(s.phase!=='lobby'||!Object.keys(s.players).length)return {error:'Wait for at least one player'};
     s.idx=0;s.phase='question';s.answers={};s.deadline=Date.now()+20000;
    }else if(action==='reveal'){
     if(getPhase(s)!=='question'&&getPhase(s)!=='reveal')return {error:'No active question'};
     s.phase='reveal';s.deadline=0;
    }else if(action==='next'){
     if(getPhase(s)!=='reveal')return {error:'Reveal the answer first'};
     if(s.idx===questionCount-1){s.phase='finished';s.deadline=0;}
     else{s.idx++;s.phase='question';s.answers={};s.deadline=Date.now()+20000;}
    }else if(action==='restart'){
     s.idx=-1;s.phase='lobby';s.answers={};s.deadline=0;
     Object.values(s.players).forEach(p=>p.score=0);
    }else return {error:'Unknown action'};
   }
   return {ok:true};
  });
  if(result.error)return makeResponse({error:result.error},result.status||400);
  return makeResponse({ok:true,...publicData(result.state,body.uid,body.token===result.state.token)});
 }catch(err){console.error('quiz backend error',err);return makeResponse({error:'Server error. Try again; if it continues, check the Netlify function logs.'},503)}
}
