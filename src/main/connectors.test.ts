import { afterEach,describe,expect,it,vi } from 'vitest';
import type { ConnectorId,ConnectorStatus } from '../shared/contracts';
import type { AppStore } from './store';

// Only warmHomebridgeAccessoryCache() (connectors.ts) touches electron
// directly — a hidden BrowserWindow used to log into Homebridge's own web
// UI once. Mocked here so that path is actually exercised and asserted on,
// not just silently swallowed by homebridgeSnapshot()'s .catch(()=>false)
// (which would make a broken warmup look identical to a working one).
const homebridgeWarmupViews:Array<{webContents:{loadURL:ReturnType<typeof vi.fn>;executeJavaScript:ReturnType<typeof vi.fn>;isLoading:ReturnType<typeof vi.fn>;once:ReturnType<typeof vi.fn>}}> =[];
vi.mock('electron',()=>({
  shell:{openExternal:vi.fn()},
  BrowserWindow:class{
    webContents={loadURL:vi.fn(async(_url:string)=>{}),executeJavaScript:vi.fn(async()=>true),isLoading:vi.fn(()=>false),once:vi.fn()};
    // BrowserWindow has its own top-level loadURL() (a real Electron
    // convenience that delegates to webContents.loadURL internally) — the
    // real code calls window.loadURL(...) directly, same as
    // browserControl.ts already does, not window.webContents.loadURL(...).
    loadURL(url:string){return this.webContents.loadURL(url);}
    on(){/* no-op */}
    // connectors.ts deliberately reuses its one hidden warmup window across
    // calls in real production use (avoids spawning a new one every time) —
    // always reporting "destroyed" here trades that fidelity for clean
    // per-test isolation instead, since each test needs its own fresh
    // window to assert against independently.
    isDestroyed(){return true;}
    constructor(){homebridgeWarmupViews.push(this as never);}
  },
}));

import { ConnectorClient } from './connectors';

const statuses=():ConnectorStatus[]=>['google','shopify','meta','dropbox'].map((id)=>({id:id as ConnectorId,label:id,configured:true,connected:true,account:id==='meta'?'act_123':'',endpoint:id==='shopify'?'store.myshopify.com':id==='meta'?'graph.facebook.com/v24.0':'',scopes:[],setupHint:''}));
const fakeStore=()=>({
  connectorStatuses:statuses,
  connectorCredentials:(id:ConnectorId)=>({account:id==='meta'?'act_123':'',endpoint:id==='shopify'?'store.myshopify.com':id==='meta'?'graph.facebook.com/v24.0':'',clientId:'client',clientSecret:'',accessToken:'scoped-token',refreshToken:'',scopes:[]}),
  recordConnectorCheck:vi.fn(),
}) as unknown as AppStore;

afterEach(()=>vi.unstubAllGlobals());

describe('service connectors',()=>{
  it('uses scoped Shopify Admin GraphQL credentials',async()=>{
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({data:{shop:{name:'Axiom Store'}}}),{status:200}));vi.stubGlobal('fetch',fetchMock);
    const result=await new ConnectorClient(fakeStore()).shopifySales(7);
    expect(result).toMatchObject({data:{shop:{name:'Axiom Store'}}});
    const [url,init]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toContain('store.myshopify.com/admin/api/2026-07/graphql.json');
    expect((init.headers as Record<string,string>)['x-shopify-access-token']).toBe('scoped-token');
  });

  it('routes Meta and Dropbox through their official API surfaces',async()=>{
    const urls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>{urls.push(String(url));return new Response('{}',{status:200});}));
    const client=new ConnectorClient(fakeStore());await client.metaInsights('last_30d');await client.dropboxList('/Axiom');
    expect(urls[0]).toContain('graph.facebook.com/v24.0/act_123/insights');
    expect(urls[1]).toBe('https://api.dropboxapi.com/2/files/list_folder');
  });
});

describe('Stripe, Klaviyo, and WhatsApp connectors',()=>{
  const fakeConnectorStore=(id:ConnectorId,credentials:Partial<{account:string;accessToken:string}>)=>({
    connectorStatuses:()=>[{id,label:id,configured:true,connected:true,account:credentials.account||'',endpoint:'',scopes:[],setupHint:''}] as unknown as ConnectorStatus[],
    connectorCredentials:()=>({account:credentials.account||'',endpoint:'',clientId:'',clientSecret:'',accessToken:credentials.accessToken||'',refreshToken:'',scopes:[]}),
    recordConnectorCheck:vi.fn(),
  }) as unknown as AppStore;

  it('reads Stripe charges with a restricted secret key, bounded to a real date window',async()=>{
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({data:[{id:'ch_1',amount:2000,currency:'usd',status:'succeeded'}]}),{status:200}));vi.stubGlobal('fetch',fetchMock);
    const result=await new ConnectorClient(fakeConnectorStore('stripe',{accessToken:'sk_restricted_123'})).stripePayments(7);
    expect(result).toMatchObject({data:[{id:'ch_1',amount:2000}]});
    const [url,init]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toMatch(/^https:\/\/api\.stripe\.com\/v1\/charges\?limit=25&created\[gte\]=\d+$/);
    expect((init.headers as Record<string,string>).authorization).toBe('Bearer sk_restricted_123');
  });

  it('refuses to read Stripe data with no key configured instead of sending an empty auth header',async()=>{
    await expect(new ConnectorClient(fakeConnectorStore('stripe',{})).stripePayments()).rejects.toThrow(/Stripe API secret key/i);
  });

  it('sends the required API-revision header on every Klaviyo request',async()=>{
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({data:[{id:'camp_1',attributes:{name:'Fall Sale'}}]}),{status:200}));vi.stubGlobal('fetch',fetchMock);
    const result=await new ConnectorClient(fakeConnectorStore('klaviyo',{accessToken:'pk_private_abc'})).klaviyoCampaigns();
    expect(result).toMatchObject({data:[{attributes:{name:'Fall Sale'}}]});
    const [url,init]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toContain('a.klaviyo.com/api/campaigns');
    const headers=init.headers as Record<string,string>;
    expect(headers.authorization).toBe('Klaviyo-API-Key pk_private_abc');
    expect(headers.revision).toBeTruthy();
  });

  it('sends a WhatsApp text message to the configured Phone Number ID',async()=>{
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({messaging_product:'whatsapp',messages:[{id:'wamid.abc'}]}),{status:200}));vi.stubGlobal('fetch',fetchMock);
    const result=await new ConnectorClient(fakeConnectorStore('whatsapp',{account:'109876543210',accessToken:'whatsapp-token'})).whatsappSend('+15551234567','Your table is ready.');
    expect(result).toMatchObject({messages:[{id:'wamid.abc'}]});
    const [url,init]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://graph.facebook.com/v24.0/109876543210/messages');
    expect(JSON.parse(String(init.body))).toMatchObject({messaging_product:'whatsapp',to:'+15551234567',type:'text',text:{body:'Your table is ready.'}});
  });

  it('surfaces the real 24-hour-window error from Meta instead of a generic failure',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'Message failed to send because more than 24 hours have passed since the customer last replied to this number.'}}),{status:400})));
    await expect(new ConnectorClient(fakeConnectorStore('whatsapp',{account:'109876543210',accessToken:'whatsapp-token'})).whatsappSend('+15551234567','Hello again')).rejects.toThrow(/24 hours/);
  });
});

describe('Homebridge Config UI X connector',()=>{
  // Unlike Home Assistant's pasted long-lived token, Homebridge Config UI X
  // only offers username/password — Axiom has to log in itself and cache
  // the resulting session JWT, re-using it instead of logging in on every
  // call. This fake store's updateConnectorTokens actually writes back into
  // what connectorCredentials returns next, so the test can prove caching
  // really happens rather than just asserting on call counts blindly.
  const fakeHomebridgeStore=()=>{
    let cachedToken='',cachedExpiry:string|undefined;
    return{
      connectorStatuses:()=>[{id:'homebridge',label:'Homebridge Config UI X',configured:true,connected:true,account:'admin',endpoint:'http://homebridge.local:8581',scopes:[],setupHint:''}] as unknown as ConnectorStatus[],
      connectorCredentials:(id:ConnectorId)=>id==='homebridge'?{account:'admin',endpoint:'http://homebridge.local:8581',clientId:'',clientSecret:'hunter2',accessToken:cachedToken,refreshToken:'',expiresAt:cachedExpiry,scopes:[]}:{account:'',endpoint:'',clientId:'',clientSecret:'',accessToken:'',refreshToken:'',scopes:[]},
      updateConnectorTokens:(_id:ConnectorId,input:{accessToken:string;expiresAt?:string})=>{cachedToken=input.accessToken;cachedExpiry=input.expiresAt;},
      recordConnectorCheck:vi.fn(),
    } as unknown as AppStore;
  };

  it('logs in with username/password once, then reuses the cached session token',async()=>{
    const requests:Array<{url:string;init?:RequestInit}>=[];let loginCalls=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      requests.push({url:String(url),init});
      if(String(url).endsWith('/api/auth/login')){loginCalls+=1;return new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200});}
      return new Response(JSON.stringify([{uniqueId:'abc123',serviceName:'Lightbulb',humanType:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:false}}]),{status:200});
    }));
    const client=new ConnectorClient(fakeHomebridgeStore());
    const first=await client.homebridgeSnapshot();
    expect(first).toMatchObject({connected:true,accessories:[{uniqueId:'abc123',name:'Office Lamp',values:{On:false}}]});
    await client.homebridgeSnapshot();
    expect(loginCalls).toBe(1);
    const accessoriesRequest=requests.find((item)=>item.url.endsWith('/api/accessories'));
    expect((accessoriesRequest!.init?.headers as Record<string,string>).authorization).toBe('Bearer jwt-session-token');
  });

  it('verifies directly from the PUT response, since Config UI X already does a real read-back before replying',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      if(String(url).endsWith('/api/auth/login'))return new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200});
      // Real Config UI X returns the refreshed accessory object from the PUT
      // itself (setAccessoryCharacteristic calls refreshCharacteristics()
      // before responding) — this must be enough to verify without an extra
      // GET round trip.
      if(init?.method==='PUT')return new Response(JSON.stringify({uniqueId:'abc123',serviceName:'Lightbulb',humanType:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:true}}),{status:200});
      return new Response(JSON.stringify([{uniqueId:'abc123',serviceName:'Lightbulb',humanType:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:false}}]),{status:200});
    }));
    const result=await new ConnectorClient(fakeHomebridgeStore()).homebridgeControl({target:'Office Lamp',value:true});
    expect(result).toMatchObject({characteristic:'On',before:false,after:true,verified:true});
  });

  it('falls back to polling GET /api/accessories/:uniqueId when the PUT response has no usable body',async()=>{
    let on=false,getSingleCalls=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      if(String(url).endsWith('/api/auth/login'))return new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200});
      if(init?.method==='PUT'){on=true;return new Response('{}',{status:200});}
      if(String(url).endsWith('/api/accessories/abc123')){getSingleCalls+=1;return new Response(JSON.stringify({uniqueId:'abc123',serviceName:'Lightbulb',humanType:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:on}}),{status:200});}
      return new Response(JSON.stringify([{uniqueId:'abc123',serviceName:'Lightbulb',humanType:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:false}}]),{status:200});
    }));
    const result=await new ConnectorClient(fakeHomebridgeStore()).homebridgeControl({target:'Office Lamp',value:true});
    expect(result).toMatchObject({characteristic:'On',before:false,after:true,verified:true});
    expect(getSingleCalls).toBeGreaterThan(0);
  });

  // The tool schema types value as string|number|boolean, so a model can send
  // "0" for a numeric HomeKit enum instead of 0. A strict === against the
  // live (always correctly-typed) read-back would then report a genuinely
  // successful, verified control action as failed.
  it('verifies successfully even when the model sent a numeric enum value as a string',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      if(String(url).endsWith('/api/auth/login'))return new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200});
      if(init?.method==='PUT')return new Response(JSON.stringify({uniqueId:'lock1',serviceName:'Lock Mechanism',humanType:'Lock',accessoryInformation:{Name:'Front Door'},values:{LockTargetState:0,LockCurrentState:0}}),{status:200});
      return new Response(JSON.stringify([{uniqueId:'lock1',serviceName:'Lock Mechanism',humanType:'Lock',accessoryInformation:{Name:'Front Door'},values:{LockTargetState:1,LockCurrentState:1}}]),{status:200});
    }));
    const result=await new ConnectorClient(fakeHomebridgeStore()).homebridgeControl({target:'Front Door',characteristic:'LockTargetState',value:'0'});
    expect(result).toMatchObject({verified:true,after:0});
  });

  it('refuses an ambiguous target instead of guessing which accessory to control',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(String(url).endsWith('/api/auth/login'))return new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200});
      return new Response(JSON.stringify([
        {uniqueId:'a',serviceName:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:false}},
        {uniqueId:'b',serviceName:'Lightbulb',accessoryInformation:{Name:'Office Lamp 2'},values:{On:false}},
      ]),{status:200});
    }));
    // 'office lamp' alone would exact-match "Office Lamp" and correctly
    // resolve unambiguously (same tiebreaker Home Assistant control uses) —
    // 'lamp' matches both names as a substring without exactly matching
    // either, so it's a genuine tie with no tiebreaker available.
    await expect(new ConnectorClient(fakeHomebridgeStore()).homebridgeControl({target:'lamp',value:true})).rejects.toThrow(/ambiguous/i);
  });

  it('surfaces a clear error instead of a raw failure when the login itself fails',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>String(url).endsWith('/api/auth/login')?new Response(JSON.stringify({message:'Invalid username or password'}),{status:401}):new Response('[]',{status:200})));
    const snapshot=await new ConnectorClient(fakeHomebridgeStore()).homebridgeSnapshot();
    expect(snapshot.connected).toBe(false);expect(snapshot.error).toContain('Invalid username or password');
  });

  // Real, live, reproduced bug: Robbie's Homebridge dashboard showed dozens
  // of accessories, but Axiom reported none — confirmed to be a documented
  // Homebridge Config UI X quirk (github.com/homebridge/homebridge-config-ui-x
  // issue #1005), not an Axiom bug: after a restart, GET /api/accessories
  // genuinely returns [] until the Accessories tab has been opened in
  // Homebridge's own web UI at least once. Rather than just tell the user to
  // do that by hand, Axiom now does it itself in a hidden window — these
  // tests exercise that real flow, not just the fallback text.
  it('automatically warms the cache in a hidden window using the real login form fields, and reports the outcome honestly when it still does not help',async()=>{
    homebridgeWarmupViews.length=0;
    let accessoryCalls=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(String(url).endsWith('/api/auth/login'))return new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200});
      accessoryCalls+=1;return new Response('[]',{status:200});
    }));
    const snapshot=await new ConnectorClient(fakeHomebridgeStore()).homebridgeSnapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.accessories).toEqual([]);
    // A hidden window really ran: logged into the real form (sourced
    // directly from Homebridge's own login.component.html — #form-username,
    // #form-pass, #submit-button) with the same credentials already saved
    // for the API, then loaded the Accessories tab.
    expect(homebridgeWarmupViews).toHaveLength(1);
    const view=homebridgeWarmupViews[0];
    expect(view.webContents.loadURL).toHaveBeenNthCalledWith(1,'http://homebridge.local:8581/login');
    expect(view.webContents.loadURL).toHaveBeenNthCalledWith(2,'http://homebridge.local:8581/accessories');
    const fillScript=view.webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(fillScript).toContain('#form-username');
    expect(fillScript).toContain('#form-pass');
    expect(fillScript).toContain('#submit-button');
    expect(fillScript).toContain('hunter2');
    // The real accessories endpoint was tried again after warming up, not
    // just once and given up on.
    expect(accessoryCalls).toBe(2);
    expect(snapshot.error).toMatch(/still reports zero/i);
  });

  it('sees the accessories once the automatic warmup populates the cache, with no hint attached',async()=>{
    homebridgeWarmupViews.length=0;
    let accessoryCalls=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(String(url).endsWith('/api/auth/login'))return new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200});
      accessoryCalls+=1;
      if(accessoryCalls===1)return new Response('[]',{status:200});
      return new Response(JSON.stringify([{uniqueId:'abc123',serviceName:'Lightbulb',humanType:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:false}}]),{status:200});
    }));
    const snapshot=await new ConnectorClient(fakeHomebridgeStore()).homebridgeSnapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.accessories).toHaveLength(1);
    expect(snapshot.error).toBeUndefined();
    expect(homebridgeWarmupViews).toHaveLength(1);
  });

  it('does not open a warmup window at all when accessories are already present on the first try',async()=>{
    homebridgeWarmupViews.length=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>String(url).endsWith('/api/auth/login')?new Response(JSON.stringify({access_token:'jwt-session-token',expires_in:28800}),{status:200}):new Response(JSON.stringify([{uniqueId:'abc123',serviceName:'Lightbulb',humanType:'Lightbulb',accessoryInformation:{Name:'Office Lamp'},values:{On:false}}]),{status:200})));
    const snapshot=await new ConnectorClient(fakeHomebridgeStore()).homebridgeSnapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.error).toBeUndefined();
    expect(homebridgeWarmupViews).toHaveLength(0);
  });
});

describe('Ring connector',()=>{
  // Ring has no official API and no simple pasted token — Axiom logs in with
  // email/password (optionally a 2FA code) itself, same shape as Homebridge's
  // login, but Ring additionally rotates its refresh token on every renewal
  // and ties it to a stable per-install hardware id. This fake store models
  // real persistence (not just call counts) so tests can prove the rotation
  // and hardware-id stability actually hold, not just that some token exists.
  const fakeRingStore=()=>{
    const state:{account:string;clientId:string;accessToken:string;refreshToken:string;expiresAt?:string}={account:'',clientId:'',accessToken:'',refreshToken:'',expiresAt:undefined};
    return{
      _state:state,
      connectorStatuses:()=>[{id:'ring',label:'Ring',configured:Boolean(state.clientId||state.accessToken),connected:Boolean(state.accessToken),account:state.account,endpoint:'',scopes:[],setupHint:''}] as unknown as ConnectorStatus[],
      connectorCredentials:(id:ConnectorId)=>id==='ring'?{account:state.account,endpoint:'',clientId:state.clientId,clientSecret:'',accessToken:state.accessToken,refreshToken:state.refreshToken,expiresAt:state.expiresAt,scopes:[]}:{account:'',endpoint:'',clientId:'',clientSecret:'',accessToken:'',refreshToken:'',scopes:[]},
      saveConnector:(input:{id:ConnectorId;account?:string;clientId?:string})=>{if(input.id==='ring'){if(input.account!==undefined)state.account=input.account;if(input.clientId!==undefined)state.clientId=input.clientId;}return[];},
      updateConnectorTokens:(id:ConnectorId,input:{accessToken:string;refreshToken?:string;expiresAt?:string})=>{if(id==='ring'){state.accessToken=input.accessToken;if(input.refreshToken!==undefined)state.refreshToken=input.refreshToken;state.expiresAt=input.expiresAt;}},
      recordConnectorCheck:vi.fn(),
    } as unknown as AppStore&{_state:typeof state};
  };
  const decodeRingRefreshToken=(wrapped:string)=>JSON.parse(Buffer.from(wrapped,'base64').toString('utf8')) as {rt:string;hid:string};

  it('returns a clean two-factor prompt instead of throwing, and does not persist anything yet',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({tsv_state:'sms',phone:'+15551234567'}),{status:412})));
    const store=fakeRingStore();
    const result=await new ConnectorClient(store).ringConnect('robbie@example.com','hunter2');
    expect(result).toEqual({twoFactorRequired:true,prompt:expect.stringContaining('sms')});
    expect(store._state.accessToken).toBe('');
  });

  it('connects with email, password, and a 2FA code, wrapping and persisting the refresh token with a stable hardware id',async()=>{
    const requests:Array<{url:string;body:string}>=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      requests.push({url:String(url),body:String(init?.body||'')});
      return new Response(JSON.stringify({access_token:'ring-access-1',expires_in:3600,refresh_token:'ring-refresh-1'}),{status:200});
    }));
    const store=fakeRingStore();
    const result=await new ConnectorClient(store).ringConnect('robbie@example.com','hunter2','123456');
    expect(result).toMatchObject({status:expect.any(Array)});
    expect(store._state.account).toBe('robbie@example.com');
    expect(store._state.accessToken).toBe('ring-access-1');
    const wrapped=decodeRingRefreshToken(store._state.refreshToken);
    expect(wrapped.rt).toBe('ring-refresh-1');
    expect(wrapped.hid).toBe(store._state.clientId);
    const body=JSON.parse(requests[0].body);
    expect(body).toMatchObject({client_id:'ring_official_android',scope:'client',grant_type:'password',username:'robbie@example.com',password:'hunter2'});
    const headers=(vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string,string>;
    expect(headers['2fa-code']).toBe('123456');
    expect(headers.hardware_id).toBe(store._state.clientId);
  });

  it('rotates and persists the refresh token on every renewal, not just at login',async()=>{
    let renewals=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      if(String(url).includes('oauth.ring.com')){
        renewals+=1;
        return new Response(JSON.stringify({access_token:`ring-access-${renewals}`,expires_in:3600,refresh_token:`ring-refresh-${renewals}`}),{status:200});
      }
      return new Response(JSON.stringify({doorbots:[],authorized_doorbots:[],stickup_cams:[]}),{status:200});
    }));
    const store=fakeRingStore();
    const client=new ConnectorClient(store);
    await client.ringConnect('robbie@example.com','hunter2');
    const firstWrapped=decodeRingRefreshToken(store._state.refreshToken);
    expect(firstWrapped.rt).toBe('ring-refresh-1');
    // Force the cached token to look expired so the next call must renew.
    store._state.expiresAt=new Date(Date.now()-1000).toISOString();
    await client.ringCameraList();
    const secondWrapped=decodeRingRefreshToken(store._state.refreshToken);
    expect(secondWrapped.rt).toBe('ring-refresh-2');
    expect(secondWrapped.hid).toBe(firstWrapped.hid);
    expect(store._state.accessToken).toBe('ring-access-2');
  });

  it('normalizes the camera list, treating an out-of-range battery_life (wired cameras) as no battery percent',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(String(url).includes('oauth.ring.com'))return new Response(JSON.stringify({access_token:'t',expires_in:3600,refresh_token:'r'}),{status:200});
      return new Response(JSON.stringify({
        doorbots:[{id:111,description:'Front Door',kind:'doorbell_v4',location_id:'loc-1',alerts:{connection:'online'},battery_life:'71'}],
        authorized_doorbots:[],
        stickup_cams:[{id:222,description:'Backyard',kind:'stickup_cam',location_id:'loc-1',alerts:{connection:'offline'},battery_life:4003}],
      }),{status:200});
    }));
    const store=fakeRingStore();
    const client=new ConnectorClient(store);
    await client.ringConnect('robbie@example.com','hunter2');
    const list=await client.ringCameraList();
    expect(list).toMatchObject({configured:true,connected:true});
    expect(list.cameras).toEqual(expect.arrayContaining([
      expect.objectContaining({id:111,name:'Front Door',online:true,batteryPercent:71}),
      expect.objectContaining({id:222,name:'Backyard',online:false,batteryPercent:undefined}),
    ]));
  });

  // A real account had cameras Ring's own server put in the `other`
  // catch-all bucket instead of `stickup_cams` — that bucket also holds
  // non-camera devices (garage openers, intercoms), so only entries whose
  // kind looks like a camera should be pulled in from it.
  it('includes camera-like devices from the `other` bucket, but not non-camera devices in it',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(String(url).includes('oauth.ring.com'))return new Response(JSON.stringify({access_token:'t',expires_in:3600,refresh_token:'r'}),{status:200});
      return new Response(JSON.stringify({
        doorbots:[{id:111,description:'Front Door',kind:'doorbell_v4',location_id:'loc-1',alerts:{connection:'online'}}],
        authorized_doorbots:[],
        stickup_cams:[],
        other:[
          {id:333,description:'Back Door',kind:'stickup_cam_solar',location_id:'loc-1',alerts:{connection:'online'}},
          {id:444,description:'Garage Door',kind:'third_party_garage_door_opener',location_id:'loc-1'},
        ],
      }),{status:200});
    }));
    const store=fakeRingStore();
    const client=new ConnectorClient(store);
    await client.ringConnect('robbie@example.com','hunter2');
    const list=await client.ringCameraList();
    expect(list.cameras.map((item)=>item.name)).toEqual(expect.arrayContaining(['Front Door','Back Door']));
    expect(list.cameras.some((item)=>item.name==='Garage Door')).toBe(false);
  });

  it('matches an exact camera name over an ambiguous substring, and rejects a genuine tie',()=>{
    const client=new ConnectorClient(fakeRingStore());
    const cameras=[
      {id:1,name:'Front Door',kind:'doorbell_v4',locationId:'l',online:true},
      {id:2,name:'Front Door Backup',kind:'stickup_cam',locationId:'l',online:true},
    ];
    expect(client.ringMatchCamera(cameras,'front door')).toMatchObject({id:1});
    expect(()=>client.ringMatchCamera(cameras,'front')).toThrow(/ambiguous/i);
    expect(()=>client.ringMatchCamera(cameras,'garage')).toThrow(/no ring camera matched/i);
  });

  // Live view itself now runs over a WebSocket ticket exchange (see
  // ringLiveView.test.ts for that flow) — this connector only fetches the
  // ticket, using the exact same auth headers as every other Ring call.
  it('fetches a live-view ticket with the same Bearer/hardware_id/User-Agent headers as every other Ring call',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      if(String(url).includes('oauth.ring.com'))return new Response(JSON.stringify({access_token:'ring-access-1',expires_in:3600,refresh_token:'ring-refresh-1'}),{status:200});
      return new Response(JSON.stringify({ticket:'signal-ticket-1'}),{status:200});
    }));
    const store=fakeRingStore();
    const client=new ConnectorClient(store);
    await client.ringConnect('robbie@example.com','hunter2');
    const ticket=await client.ringTicket();
    expect(ticket).toBe('signal-ticket-1');
    const ticketCall=vi.mocked(fetch).mock.calls.find(([url])=>String(url).includes('clap/ticket'));
    expect(ticketCall?.[0]).toBe('https://prd-api-us.prd.rings.solutions/api/v1/clap/ticket/request/signalsocket');
    const headers=(ticketCall?.[1] as RequestInit).headers as Record<string,string>;
    expect(headers.authorization).toBe('Bearer ring-access-1');
    expect(headers.hardware_id).toBe(store._state.clientId);
    expect(headers['User-Agent']).toBe('android:com.ringapp');
  });

  it('throws a clear error when Ring does not return a ticket',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(String(url).includes('oauth.ring.com'))return new Response(JSON.stringify({access_token:'t',expires_in:3600,refresh_token:'r'}),{status:200});
      return new Response('{}',{status:200});
    }));
    const store=fakeRingStore();
    const client=new ConnectorClient(store);
    await client.ringConnect('robbie@example.com','hunter2');
    await expect(client.ringTicket()).rejects.toThrow(/did not return a live-view ticket/i);
  });
});
