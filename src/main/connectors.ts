import crypto from 'node:crypto';
import http from 'node:http';
import { shell } from 'electron';
import type { ConnectorId, ConnectorStatus, HomebridgeAccessory, HomebridgeControlRequest, HomebridgeControlResult, HomebridgeSnapshot, RingCamera, RingCameraList } from '../shared/contracts';
import type { AppStore } from './store';

const googleScopes=['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/calendar'];

class RingTwoFactorRequiredError extends Error{constructor(prompt:string){super(prompt);this.name='RingTwoFactorRequiredError';}}

export class ConnectorClient {
  constructor(private readonly store:AppStore){}

  statuses():ConnectorStatus[]{return this.store.connectorStatuses();}
  async connect(id:ConnectorId):Promise<ConnectorStatus[]>{if(id!=='google')throw new Error(`${id} uses a scoped access token in Settings. Save the token, then use TEST to verify the connection.`);await this.connectGoogle();return this.statuses();}
  disconnect(id:ConnectorId):ConnectorStatus[]{return this.store.disconnectConnector(id);}

  async test(id:ConnectorId):Promise<ConnectorStatus>{
    try{
      if(id==='google')await this.googleJson('https://www.googleapis.com/oauth2/v2/userinfo');
      else if(id==='shopify')await this.shopifyGraphql('{ shop { name myshopifyDomain } }');
      else if(id==='meta')await this.metaJson('me?fields=id,name');
      else if(id==='dropbox')await this.dropboxJson('https://api.dropboxapi.com/2/users/get_current_account',{});
      else if(id==='homebridge')await this.homebridgeJson('/api/accessories');
      else if(id==='ring')await this.ringJson('https://api.ring.com/clients_api/ring_devices');
      else if(id==='stripe')await this.stripeJson('balance');
      else if(id==='klaviyo')await this.klaviyoJson('accounts');
      else await this.whatsappJson('?fields=verified_name,display_phone_number');
      this.store.recordConnectorCheck(id);return this.statuses().find((item)=>item.id===id)!;
    }catch(reason){const detail=reason instanceof Error?reason.message:String(reason);this.store.recordConnectorCheck(id,detail);throw new Error(detail);}
  }

  async gmailList(query='',maxResults=10):Promise<unknown>{
    const list=await this.googleJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.max(1,Math.min(25,maxResults))}&q=${encodeURIComponent(query)}`) as {messages?:Array<{id:string}>};
    const messages=await Promise.all((list.messages||[]).slice(0,25).map((item)=>this.googleJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
    return{messages};
  }
  async gmailModify(id:string,removeLabelIds:string[]=[],addLabelIds:string[]=[]):Promise<unknown>{return this.googleJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`,{method:'POST',body:JSON.stringify({removeLabelIds,addLabelIds})});}
  async gmailSend(to:string,subject:string,body:string):Promise<unknown>{const raw=Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,'utf8').toString('base64url');return this.googleJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',body:JSON.stringify({raw})});}
  async calendarEvents(timeMin=new Date().toISOString(),maxResults=20):Promise<unknown>{return this.googleJson(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}&maxResults=${Math.max(1,Math.min(50,maxResults))}`);}
  async calendarCreate(summary:string,start:string,end:string,description=''):Promise<unknown>{return this.googleJson('https://www.googleapis.com/calendar/v3/calendars/primary/events',{method:'POST',body:JSON.stringify({summary,description,start:{dateTime:new Date(start).toISOString()},end:{dateTime:new Date(end).toISOString()}})});}
  async shopifySales(days=7):Promise<unknown>{const since=new Date(Date.now()-Math.max(1,Math.min(365,days))*86_400_000).toISOString();return this.shopifyGraphql(`query AxiomSales($query:String!){shop{name currencyCode} orders(first:100,query:$query,sortKey:CREATED_AT,reverse:true){nodes{id name createdAt displayFinancialStatus totalPriceSet{shopMoney{amount currencyCode}}}}}`,{query:`created_at:>=${since}`});}
  async metaInsights(datePreset='last_7d'):Promise<unknown>{const credentials=this.store.connectorCredentials('meta'),account=credentials.account.replace(/^act_/,'');if(!account)throw new Error('Add the Meta ad account ID in Settings.');return this.metaJson(`act_${encodeURIComponent(account)}/insights?fields=spend,impressions,clicks,reach,actions&date_preset=${encodeURIComponent(datePreset)}`);}
  async dropboxList(pathValue=''):Promise<unknown>{return this.dropboxJson('https://api.dropboxapi.com/2/files/list_folder',{path:pathValue,recursive:false,include_deleted:false,limit:100});}
  // Stripe's REST API takes form-encoded query params even on GET, and a
  // restricted read-only key (the setup hint asks for one specifically)
  // means there's no server-side risk of this reading more than Balances/
  // Charges/Customers/PaymentIntents even if a tool argument were malformed.
  async stripePayments(days=7):Promise<unknown>{const since=Math.floor((Date.now()-Math.max(1,Math.min(365,days))*86_400_000)/1000);return this.stripeJson(`charges?limit=25&created[gte]=${since}`);}
  private async stripeJson(route:string):Promise<unknown>{const value=this.store.connectorCredentials('stripe');if(!value.accessToken)throw new Error('Configure a Stripe API secret key in Settings.');return requestJson(`https://api.stripe.com/v1/${route}`,{headers:{authorization:`Bearer ${value.accessToken}`}});}
  // Klaviyo requires a fixed API-revision header on every request — omitting
  // it either fails outright or silently pins to a stale default revision
  // depending on the endpoint, so it's always sent explicitly rather than
  // relying on Klaviyo's own default.
  async klaviyoCampaigns():Promise<unknown>{return this.klaviyoJson("campaigns?filter=equals(messages.channel,'email')&page[size]=25");}
  private async klaviyoJson(route:string):Promise<unknown>{const value=this.store.connectorCredentials('klaviyo');if(!value.accessToken)throw new Error('Configure a Klaviyo Private API Key in Settings.');return requestJson(`https://a.klaviyo.com/api/${route}`,{headers:{authorization:`Klaviyo-API-Key ${value.accessToken}`,revision:'2025-04-15'}});}
  // WhatsApp's Cloud API only allows a free-form text message within 24
  // hours of the recipient's last message to this business number; outside
  // that window Meta's API itself rejects it and requires a pre-approved
  // template instead — surfaced as a real error from Meta, not guessed at
  // here, so the failure message is whatever Meta's own API actually says.
  async whatsappSend(to:string,body:string):Promise<unknown>{const clean=to.trim();if(!clean)throw new Error('A recipient phone number is required.');if(!body.trim())throw new Error('Message text is required.');return this.whatsappJson('/messages',{method:'POST',body:JSON.stringify({messaging_product:'whatsapp',to:clean,type:'text',text:{body:body.slice(0,4096)}})});}
  private async whatsappJson(route:string,init:RequestInit={}):Promise<unknown>{const value=this.store.connectorCredentials('whatsapp');if(!value.account||!value.accessToken)throw new Error('Configure the WhatsApp Phone Number ID and access token in Settings.');return requestJson(`https://graph.facebook.com/v24.0/${encodeURIComponent(value.account)}${route}`,{...init,headers:{authorization:`Bearer ${value.accessToken}`,'content-type':'application/json',...(init.headers||{})}});}
  homebridgeConnection():{endpoint:string;username:string;password:string}{const value=this.store.connectorCredentials('homebridge'),raw=value.endpoint.trim();if(!raw||!value.account||!value.clientSecret)throw new Error('Configure the Homebridge UI URL, username, and password in Settings.');const endpoint=/^https?:\/\//i.test(raw)?raw:`http://${raw}`;let url:URL;try{url=new URL(endpoint);}catch{throw new Error('Homebridge UI URL is invalid. Use http://homebridge.local:8581 or your address.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Homebridge UI URL must use HTTP or HTTPS without embedded credentials.');return{endpoint:url.toString().replace(/\/$/,''),username:value.account,password:value.clientSecret};}
  /** Homebridge Config UI X has no long-lived-token concept like Home
   * Assistant — it issues a short-lived JWT from a username/password login.
   * Cached until near expiry, then transparently re-logged-in. */
  private async homebridgeToken():Promise<string>{const value=this.store.connectorCredentials('homebridge');if(value.accessToken&&(!value.expiresAt||Date.parse(value.expiresAt)>Date.now()+30_000))return value.accessToken;const connection=this.homebridgeConnection();const response=await fetch(`${connection.endpoint}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:connection.username,password:connection.password}),signal:AbortSignal.timeout(12_000)});const data=await response.json().catch(()=>({})) as {access_token?:string;expires_in?:number;message?:string};if(!response.ok||!data.access_token)throw new Error(data.message||`Homebridge login failed (${response.status}). Check the URL, username, and password in Settings.`);this.store.updateConnectorTokens('homebridge',{accessToken:data.access_token,expiresAt:new Date(Date.now()+(data.expires_in||28_800)*1000).toISOString()});return data.access_token;}
  private async homebridgeJson(route:string,init:RequestInit={}):Promise<unknown>{const connection=this.homebridgeConnection(),token=await this.homebridgeToken();return requestJson(`${connection.endpoint}${route}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(init.headers||{})}});}
  // Confirmed live (github.com/homebridge/homebridge-config-ui-x#1005): after
  // a Homebridge restart, GET /api/accessories genuinely returns an empty
  // array until someone opens the Accessories tab in Homebridge's own web
  // UI at least once — Config UI X populates its accessory cache from that
  // page load, not from the plain REST call alone. Reproduced exactly with
  // Robbie's real instance: Axiom reported zero devices, then correctly saw
  // all of them the moment the Homebridge dashboard had been opened in a
  // browser. Surfaced as guidance here (connected stays true — the request
  // itself succeeded) rather than left to look like Axiom itself is broken.
  async homebridgeSnapshot():Promise<HomebridgeSnapshot>{const status=this.statuses().find((item)=>item.id==='homebridge')!,generatedAt=new Date().toISOString();if(!status.configured)return{configured:false,connected:false,endpoint:status.endpoint,generatedAt,accessories:[],counts:{},error:'Homebridge is not configured.'};try{const raw=await this.homebridgeJson('/api/accessories') as unknown[],accessories=(Array.isArray(raw)?raw:[]).map((item)=>this.normalizeHomebridgeAccessory(item)).filter((item):item is HomebridgeAccessory=>Boolean(item)),counts:Record<string,number>={};for(const item of accessories)counts[item.type]=(counts[item.type]||0)+1;const emptyCacheHint=Array.isArray(raw)&&raw.length===0?'Homebridge reported zero accessories. This is a known Homebridge Config UI X quirk after a restart — its accessory cache only populates once the Accessories tab has been opened in its own web UI at least once. Open http://<your-homebridge-address>/accessories in a browser, then ask again.':undefined;return{configured:true,connected:true,endpoint:status.endpoint,generatedAt,accessories,counts,error:emptyCacheHint};}catch(reason){return{configured:true,connected:false,endpoint:status.endpoint,generatedAt,accessories:[],counts:{},error:reason instanceof Error?reason.message:String(reason)};}}
  async homebridgeControl(input:HomebridgeControlRequest):Promise<HomebridgeControlResult>{const raw=await this.homebridgeJson('/api/accessories') as unknown[],accessories=(Array.isArray(raw)?raw:[]).map((item)=>this.normalizeHomebridgeAccessory(item)).filter((item):item is HomebridgeAccessory=>Boolean(item)),target=String(input.target||'').trim().toLowerCase();if(!target)throw new Error('A smart-home target is required.');const candidates=accessories.filter((item)=>item.uniqueId.toLowerCase()===target||item.name.toLowerCase()===target||item.name.toLowerCase().includes(target));const exact=candidates.filter((item)=>item.uniqueId.toLowerCase()===target||item.name.toLowerCase()===target),accessory=(exact.length===1?exact:candidates).length===1?(exact.length===1?exact:candidates)[0]:undefined;if(!accessory)throw new Error(candidates.length?`Smart-home target is ambiguous: ${candidates.slice(0,8).map((item)=>item.name).join(', ')}.`:`No Homebridge accessory matched “${input.target}”. Ask Axiom to list smart devices first.`);const characteristic=input.characteristic||(Object.prototype.hasOwnProperty.call(accessory.values,'On')?'On':Object.keys(accessory.values)[0]);if(!characteristic||!(characteristic in accessory.values))throw new Error(`${accessory.name} has no “${characteristic||''}” characteristic to set.`);const before=accessory.values[characteristic];
    // Config UI X's PUT handler already does a real HAP read-back of the
    // accessory (setCharacteristic, then refreshCharacteristics) before it
    // responds, so its response body is itself a genuine independent
    // verification — not an optimistic echo of what we asked for. Trust it
    // when present, and only fall back to polling GET /api/accessories/:id
    // (the original behavior) when that body is missing or incomplete, so
    // the verification guarantee never weakens, it just usually completes
    // in one round trip instead of up to five.
    const putBody=this.normalizeHomebridgeAccessory(await this.homebridgeJson(`/api/accessories/${encodeURIComponent(accessory.uniqueId)}`,{method:'PUT',body:JSON.stringify({characteristicType:characteristic,value:input.value})}));
    let after:unknown=putBody?putBody.values[characteristic]:undefined,verified=sameHomebridgeValue(after,input.value);
    for(let attempt=0;!verified&&attempt<4;attempt++){await new Promise((resolve)=>setTimeout(resolve,180+attempt*120));const observed=this.normalizeHomebridgeAccessory(await this.homebridgeJson(`/api/accessories/${encodeURIComponent(accessory.uniqueId)}`));if(observed){after=observed.values[characteristic];verified=sameHomebridgeValue(after,input.value);}}
    if(!verified)throw new Error(`Homebridge accepted the request, but ${accessory.name}’s ${characteristic} reports ${JSON.stringify(after)} instead of ${JSON.stringify(input.value)}.`);return{accessory:{...accessory,values:{...accessory.values,[characteristic]:after}},characteristic,before,after,verified,executedAt:new Date().toISOString()};}
  private normalizeHomebridgeAccessory(value:unknown):HomebridgeAccessory|undefined{if(!value||typeof value!=='object')return undefined;const item=value as {uniqueId?:unknown;serviceName?:unknown;humanType?:unknown;accessoryInformation?:{Name?:unknown};values?:Record<string,unknown>};const uniqueId=String(item.uniqueId||'');if(!uniqueId)return undefined;const serviceName=String(item.serviceName||'Accessory'),name=String(item.accessoryInformation?.Name||serviceName||uniqueId),type=String(item.humanType||serviceName);return{uniqueId,name,type,serviceName,values:item.values&&typeof item.values==='object'?{...item.values}:{}};}

  // Ring has no official public API and no app-registerable OAuth client —
  // every unofficial integration (Home Assistant, Homebridge's ring plugin)
  // authenticates by imitating Ring's own Android app, including its fixed
  // client_id and User-Agent. This is the same account the user already
  // signs into the real Ring app with; nothing here talks to anyone else's
  // account or bypasses anything.
  private async ringHardwareId():Promise<string>{const value=this.store.connectorCredentials('ring');if(value.clientId)return value.clientId;const id=crypto.randomUUID();this.store.saveConnector({id:'ring',clientId:id});return id;}
  private async ringOAuthToken(grant:Record<string,unknown>,twoFactorCode:string|undefined,hardwareId:string):Promise<{access_token:string;expires_in:number;refresh_token:string}>{
    const response=await fetch('https://oauth.ring.com/oauth/token',{method:'POST',headers:{'content-type':'application/json','2fa-support':'true','2fa-code':twoFactorCode||'',hardware_id:hardwareId,'User-Agent':'android:com.ringapp'},body:JSON.stringify({client_id:'ring_official_android',scope:'client',...grant}),signal:AbortSignal.timeout(15_000)});
    const text=await response.text();let data:unknown;try{data=JSON.parse(text);}catch{data={};}
    if(response.status===412||(response.status===400&&typeof (data as {error?:unknown}).error==='string'&&(data as {error:string}).error.startsWith('Verification Code'))){
      const body=data as {tsv_state?:'sms'|'email'|'totp';phone?:string};
      const prompt=response.status===400?'Invalid verification code entered. Please try again.':body.tsv_state?`Please enter the code ${body.tsv_state==='totp'?'from your authenticator app':`sent to ${body.phone||'your phone'} via ${body.tsv_state}`}.`:'Please enter the verification code sent to your text or email.';
      throw new RingTwoFactorRequiredError(prompt);
    }
    if(!response.ok){const body=data as {error_description?:string;error?:string};throw new Error(body.error_description||body.error||`Ring sign-in failed (${response.status}). Verify your email and password are correct.`);}
    const body=data as {access_token?:string;expires_in?:number;refresh_token?:string};
    if(!body.access_token||!body.refresh_token)throw new Error('Ring sign-in response was missing an access token.');
    return{access_token:body.access_token,expires_in:body.expires_in||3600,refresh_token:body.refresh_token};
  }
  async ringConnect(email:string,password:string,twoFactorCode?:string):Promise<{status:ConnectorStatus[]}|{twoFactorRequired:true;prompt:string}>{
    const trimmedEmail=email.trim();if(!trimmedEmail||!password)throw new Error('Enter your Ring email and password.');
    const hardwareId=await this.ringHardwareId();
    try{
      const auth=await this.ringOAuthToken({grant_type:'password',username:trimmedEmail,password},twoFactorCode,hardwareId);
      const refreshToken=Buffer.from(JSON.stringify({rt:auth.refresh_token,hid:hardwareId}),'utf8').toString('base64');
      this.store.updateConnectorTokens('ring',{accessToken:auth.access_token,refreshToken,expiresAt:new Date(Date.now()+auth.expires_in*1000).toISOString(),scopes:['client']});
      this.store.saveConnector({id:'ring',account:trimmedEmail});
      return{status:this.statuses()};
    }catch(reason){
      if(reason instanceof RingTwoFactorRequiredError)return{twoFactorRequired:true,prompt:reason.message};
      throw reason;
    }
  }
  /** Ring rotates the refresh token on every renewal, wrapped here (like the
   * reference client) as base64 JSON of {rt, hid} so the hardware id stays
   * consistent across refreshes — Ring ties a refresh token to the device
   * that requested it. Persisting only a new access token here would work
   * until the next restart, then silently and permanently fail with no
   * recovery except re-entering email/password/2FA from scratch. */
  private async ringToken():Promise<string>{
    const value=this.store.connectorCredentials('ring');
    if(value.accessToken&&(!value.expiresAt||Date.parse(value.expiresAt)>Date.now()+60_000))return value.accessToken;
    if(!value.refreshToken)throw new Error('Ring is not connected. Add your email and password in Settings.');
    let wrapped:{rt?:string;hid?:string};
    try{wrapped=JSON.parse(Buffer.from(value.refreshToken,'base64').toString('utf8'));}catch{wrapped={};}
    if(!wrapped.rt)throw new Error('Ring session is invalid. Reconnect Ring in Settings.');
    const hardwareId=wrapped.hid||await this.ringHardwareId();
    let auth:{access_token:string;expires_in:number;refresh_token:string};
    try{auth=await this.ringOAuthToken({grant_type:'refresh_token',refresh_token:wrapped.rt},undefined,hardwareId);}
    catch(reason){throw new Error(`Ring session expired. Reconnect Ring in Settings. (${reason instanceof Error?reason.message:String(reason)})`);}
    const refreshToken=Buffer.from(JSON.stringify({rt:auth.refresh_token,hid:hardwareId}),'utf8').toString('base64');
    this.store.updateConnectorTokens('ring',{accessToken:auth.access_token,refreshToken,expiresAt:new Date(Date.now()+auth.expires_in*1000).toISOString(),scopes:['client']});
    return auth.access_token;
  }
  private async ringJson(url:string,init:RequestInit={}):Promise<unknown>{const token=await this.ringToken(),hardwareId=await this.ringHardwareId();return requestJson(url,{...init,headers:{authorization:`Bearer ${token}`,hardware_id:hardwareId,'User-Agent':'android:com.ringapp','content-type':'application/json',...(init.headers||{})}});}
  async ringCameraList():Promise<RingCameraList>{
    const status=this.statuses().find((item)=>item.id==='ring')!;
    if(!status.configured)return{configured:false,connected:false,cameras:[],error:'Ring is not configured.'};
    try{
      const raw=await this.ringJson('https://api.ring.com/clients_api/ring_devices') as {doorbots?:unknown[];authorized_doorbots?:unknown[];stickup_cams?:unknown[];other?:Array<{kind?:unknown}>};
      // `other` is Ring's catch-all bucket — it also holds non-camera
      // devices (garage door openers, intercoms), so only pull in entries
      // whose kind actually looks like a camera. This exists because a
      // real account had cameras (older/solar models, apparently) that
      // Ring's own server puts here instead of in `stickup_cams`.
      const otherCameras=(raw.other||[]).filter((item)=>/cam/i.test(String(item.kind||'')));
      const cameras=[...(raw.doorbots||[]),...(raw.authorized_doorbots||[]),...(raw.stickup_cams||[]),...otherCameras].map((item)=>this.normalizeRingCamera(item)).filter((item):item is RingCamera=>Boolean(item));
      return{configured:true,connected:true,cameras};
    }catch(reason){return{configured:true,connected:false,cameras:[],error:reason instanceof Error?reason.message:String(reason)};}
  }
  private normalizeRingCamera(value:unknown):RingCamera|undefined{
    if(!value||typeof value!=='object')return undefined;
    const item=value as {id?:unknown;description?:unknown;kind?:unknown;location_id?:unknown;alerts?:{connection?:unknown};battery_life?:unknown};
    const id=Number(item.id);if(!Number.isFinite(id))return undefined;
    // Wired (plugged-in) cameras report a non-percentage sentinel like 4003
    // instead of 0-100 — only surface battery_life when it's plausibly one.
    const batteryRaw=item.battery_life,batteryNumber=typeof batteryRaw==='number'?batteryRaw:typeof batteryRaw==='string'?Number(batteryRaw):NaN,batteryPercent=Number.isFinite(batteryNumber)&&batteryNumber>=0&&batteryNumber<=100?batteryNumber:undefined;
    return{id,name:String(item.description||`Camera ${id}`),kind:String(item.kind||'camera'),locationId:String(item.location_id||''),online:item.alerts?.connection==='online',batteryPercent};
  }
  /** Direct port of homebridgeControl()'s target-matching logic above —
   * lowercase exact match wins over substring matches, and an unresolved
   * tie is a hard error rather than a guess. */
  ringMatchCamera(cameras:RingCamera[],target:string):RingCamera{
    const clean=target.trim().toLowerCase();if(!clean)throw new Error('A Ring camera name is required.');
    const candidates=cameras.filter((item)=>String(item.id)===clean||item.name.toLowerCase()===clean||item.name.toLowerCase().includes(clean));
    const exact=candidates.filter((item)=>String(item.id)===clean||item.name.toLowerCase()===clean);
    const pool=exact.length===1?exact:candidates;
    if(pool.length===1)return pool[0];
    if(pool.length>1)throw new Error(`Ring camera is ambiguous: ${pool.slice(0,8).map((item)=>item.name).join(', ')}.`);
    throw new Error(cameras.length?`No Ring camera matched “${target}”. Your Ring cameras are: ${cameras.map((item)=>item.name).join(', ')}.`:`No Ring camera matched “${target}”, and the account has no cameras at all.`);
  }
  // Live view actually runs over a WebSocket ticket exchange (see
  // src/main/ringLiveView.ts), not a single REST call — this is the one
  // piece of that flow that needs the same auth machinery as everything
  // else in this class, so it stays here rather than duplicating
  // ringToken()/ringHardwareId() in the WebSocket module.
  async ringTicket():Promise<string>{
    const response=await this.ringJson('https://prd-api-us.prd.rings.solutions/api/v1/clap/ticket/request/signalsocket',{method:'POST'}) as {ticket?:string};
    if(!response.ticket)throw new Error('Ring did not return a live-view ticket.');
    return response.ticket;
  }

  private async connectGoogle():Promise<void>{
    const credentials=this.store.connectorCredentials('google');if(!credentials.clientId)throw new Error('Add a Google Desktop OAuth client ID in Settings first.');
    const verifier=crypto.randomBytes(48).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url'),state=crypto.randomBytes(24).toString('hex');
    const result=await new Promise<{code:string;redirectUri:string}>((resolve,reject)=>{let redirectUri='';const server=http.createServer((request,response)=>{try{const url=new URL(request.url||'/',`http://${request.headers.host}`);if(url.pathname!=='/oauth/google')return;const code=url.searchParams.get('code'),returnedState=url.searchParams.get('state'),error=url.searchParams.get('error');response.writeHead(code&&returnedState===state?200:400,{'content-type':'text/html; charset=utf-8'});response.end(`<html><body style="font-family:system-ui;background:#061015;color:#d9ffff;padding:40px"><h2>${code&&returnedState===state?'Axiom connected':'Connection failed'}</h2><p>You can close this browser window and return to Axiom.</p></body></html>`);server.close();if(error)reject(new Error(`Google authorization failed: ${error}`));else if(!code||returnedState!==state)reject(new Error('Google authorization response failed the state check.'));else resolve({code,redirectUri});}catch(reason){server.close();reject(reason);}});server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address() as {port:number};redirectUri=`http://127.0.0.1:${address.port}/oauth/google`;const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.searchParams.set('client_id',credentials.clientId);url.searchParams.set('redirect_uri',redirectUri);url.searchParams.set('response_type','code');url.searchParams.set('scope',googleScopes.join(' '));url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');url.searchParams.set('code_challenge',challenge);url.searchParams.set('code_challenge_method','S256');url.searchParams.set('state',state);void shell.openExternal(url.toString());});setTimeout(()=>{server.close();reject(new Error('Google authorization timed out.'));},180_000).unref();});
    const body=new URLSearchParams({client_id:credentials.clientId,code:result.code,code_verifier:verifier,redirect_uri:result.redirectUri,grant_type:'authorization_code'});if(credentials.clientSecret)body.set('client_secret',credentials.clientSecret);const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(12_000)});const data=await response.json() as {access_token?:string;refresh_token?:string;expires_in?:number;scope?:string;error_description?:string};if(!response.ok||!data.access_token)throw new Error(data.error_description||`Google token exchange failed (${response.status}).`);this.store.updateConnectorTokens('google',{accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:new Date(Date.now()+(data.expires_in||3600)*1000).toISOString(),scopes:data.scope?.split(' ')||googleScopes});const profile=await this.googleJson('https://www.googleapis.com/oauth2/v2/userinfo') as {email?:string};if(profile.email)this.store.saveConnector({id:'google',account:profile.email});
  }

  private async googleToken():Promise<string>{const value=this.store.connectorCredentials('google');if(value.accessToken&&(!value.expiresAt||Date.parse(value.expiresAt)>Date.now()+60_000))return value.accessToken;if(!value.refreshToken||!value.clientId)throw new Error('Connect Google in Settings first.');const body=new URLSearchParams({client_id:value.clientId,refresh_token:value.refreshToken,grant_type:'refresh_token'});if(value.clientSecret)body.set('client_secret',value.clientSecret);const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(12_000)});const data=await response.json() as {access_token?:string;expires_in?:number;scope?:string;error_description?:string};if(!response.ok||!data.access_token)throw new Error(data.error_description||`Google token refresh failed (${response.status}).`);this.store.updateConnectorTokens('google',{accessToken:data.access_token,expiresAt:new Date(Date.now()+(data.expires_in||3600)*1000).toISOString(),scopes:data.scope?.split(' ')||value.scopes});return data.access_token;}
  private async googleJson(url:string,init:RequestInit={}):Promise<unknown>{const token=await this.googleToken();return requestJson(url,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(init.headers||{})}});}
  private async shopifyGraphql(query:string,variables:Record<string,unknown>={}):Promise<unknown>{const value=this.store.connectorCredentials('shopify');if(!value.endpoint||!value.accessToken)throw new Error('Configure the Shopify store domain and Admin API token in Settings.');return requestJson(`https://${value.endpoint}/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'content-type':'application/json','x-shopify-access-token':value.accessToken},body:JSON.stringify({query,variables})});}
  private async metaJson(route:string):Promise<unknown>{const value=this.store.connectorCredentials('meta');if(!value.accessToken)throw new Error('Configure a Meta Graph API access token in Settings.');const base=value.endpoint?`https://${value.endpoint}`:'https://graph.facebook.com/v24.0';return requestJson(`${base}/${route}${route.includes('?')?'&':'?'}access_token=${encodeURIComponent(value.accessToken)}`);}
  private async dropboxJson(url:string,body:Record<string,unknown>):Promise<unknown>{const value=this.store.connectorCredentials('dropbox');if(!value.accessToken)throw new Error('Configure a Dropbox access token in Settings.');return requestJson(url,{method:'POST',headers:{authorization:`Bearer ${value.accessToken}`,'content-type':'application/json'},body:JSON.stringify(body)});}
}

// The homebridge_control tool schema types value as string|number|boolean
// (so models are free to send "0" or 0, "true" or true), but the live state
// read back from Homebridge is always the accessory's real typed value — a
// strict === between them would report a successful, verified control action
// as failed just because the model phrased its argument as the "wrong"
// JS type. Normalizes both sides onto a common form before comparing.
function sameHomebridgeValue(a:unknown,b:unknown):boolean{
  const normalize=(value:unknown):string=>{
    if(typeof value==='boolean')return value?'1':'0';
    if(typeof value==='string'){const lower=value.trim().toLowerCase();if(lower==='true')return'1';if(lower==='false')return'0';return lower;}
    return String(value);
  };
  return normalize(a)===normalize(b);
}

// NestJS APIs (Homebridge Config UI X) shape errors as {statusCode,message,error}
// where .message is the specific, human-readable reason and .error is just the
// generic HTTP status phrase ("Bad Request"/"Unauthorized") — a bare string
// .error must never outrank a real .message, or a specific reason like
// "Homebridge must be running in insecure mode to access accessories." gets
// silently replaced with "Bad Request". Meta/Google Graph errors nest their
// message inside an .error object instead; Shopify GraphQL uses top-level
// .errors[]; Dropbox uses .error_summary. All are checked, most specific first.
async function requestJson(url:string,init:RequestInit={}):Promise<unknown>{
  const response=await fetch(url,{...init,signal:init.signal??AbortSignal.timeout(12_000)}),text=await response.text();
  let data:unknown,parsed=true;try{data=JSON.parse(text);}catch{data={};parsed=false;}
  if(!response.ok){
    const body=data as {message?:unknown;error?:unknown;errors?:Array<{message?:string}>;error_summary?:string},errorObject=body.error&&typeof body.error==='object'?body.error as {message?:string}:undefined;
    const known=(typeof body.message==='string'&&body.message)||errorObject?.message||body.errors?.[0]?.message||body.error_summary||(typeof body.error==='string'?body.error:undefined);
    // No known field matched — this is usually a provider we haven't seen an
    // error from before (a new one, like Ring's live-view API, or a genuine
    // server-side failure with no structured body at all). Surfacing the raw
    // response instead of a bare status code is the difference between a
    // debuggable failure and a dead end.
    const raw=text.trim()?`: ${text.trim().slice(0,300)}`:parsed?`: ${JSON.stringify(data).slice(0,300)}`:'';
    throw new Error(known||`Connector request failed (${response.status})${raw}`);
  }
  return data;
}
