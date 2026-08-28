import os from 'node:os';
import { execFile } from 'node:child_process';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import type { DiskTelemetry, GpuTelemetry, NetworkTelemetry, ProcessTelemetry, SystemTelemetry } from '../shared/contracts';

type StaticSnapshot={
  system:Awaited<ReturnType<typeof si.system>>;
  cpu:Awaited<ReturnType<typeof si.cpu>>;
  os:Awaited<ReturnType<typeof si.osInfo>>;
  graphics:Awaited<ReturnType<typeof si.graphics>>;
  networkInterfaces:Systeminformation.NetworkInterfacesData[];
};

const clamp=(value:number,min=0,max=100)=>Math.max(min,Math.min(max,value));
const finite=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null;
const percent=(value:unknown):number=>Math.round(clamp(finite(value)??0)*10)/10;
const positive=(value:unknown):number=>Math.max(0,finite(value)??0);
const usefulTemperature=(value:unknown):number|null=>{const number=finite(value);return number!==null&&number>0&&number<150?Math.round(number*10)/10:null;};
const settled=<T>(result:PromiseSettledResult<T>):T|undefined=>result.status==='fulfilled'?result.value:undefined;
const processView=(item:{pid:number;name:string;cpu:number;mem:number}):ProcessTelemetry=>({pid:item.pid,name:String(item.name||'Unknown').slice(0,80),cpuPercent:percent(item.cpu),memoryPercent:percent(item.mem)});
type NvidiaReading={model:string;loadPercent:number|null;memoryLoadPercent:number|null;temperatureC:number|null;fanPercent:number|null;powerWatts:number|null;memoryTotalMB:number|null;memoryUsedMB:number|null;driver:string};
function nvidiaTelemetry():Promise<NvidiaReading[]>{
  return new Promise((resolve)=>{execFile('nvidia-smi',['--query-gpu=name,utilization.gpu,utilization.memory,temperature.gpu,fan.speed,power.draw,memory.total,memory.used,driver_version','--format=csv,noheader,nounits'],{windowsHide:true,timeout:3500},(error,stdout)=>{if(error){resolve([]);return;}resolve(String(stdout).trim().split(/\r?\n/).filter(Boolean).map((line)=>{const values=line.split(',').map((value)=>value.trim()),number=(value:string|undefined)=>value&&!/^n\/a$/i.test(value)?finite(Number(value)):null;return{model:values[0]||'NVIDIA GPU',loadPercent:number(values[1]),memoryLoadPercent:number(values[2]),temperatureC:usefulTemperature(number(values[3])),fanPercent:number(values[4]),powerWatts:number(values[5]),memoryTotalMB:number(values[6]),memoryUsedMB:number(values[7]),driver:values[8]||''};}));});});
}
const interfaceKey=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'');

let staticCache:StaticSnapshot|undefined;
let staticCacheAt=0;
let inFlight:Promise<SystemTelemetry>|undefined;
let lastGood:SystemTelemetry|undefined;
let lastExtendedAt=0;
let previousCpu=os.cpus().map((cpu)=>({idle:cpu.times.idle,total:Object.values(cpu.times).reduce((sum,value)=>sum+value,0)}));

function fastCpuLoad():{total:number;perCore:number[]}{
  const current=os.cpus().map((cpu)=>({idle:cpu.times.idle,total:Object.values(cpu.times).reduce((sum,value)=>sum+value,0)}));
  const perCore=current.map((cpu,index)=>{const before=previousCpu[index]??cpu,total=cpu.total-before.total,idle=cpu.idle-before.idle;return total>0?percent((1-idle/total)*100):0;});
  previousCpu=current;
  return{total:perCore.length?Math.round(perCore.reduce((sum,value)=>sum+value,0)/perCore.length*10)/10:0,perCore};
}

function quickSnapshot():SystemTelemetry{
  const load=fastCpuLoad(),total=os.totalmem(),free=os.freemem(),used=total-free,memoryPercent=total?percent(used/total*100):0,now=new Date().toISOString();
  if(lastGood)return{...lastGood,collectedAt:now,cpuPercent:load.total,memoryPercent,uptimeSeconds:Math.round(os.uptime()),cpu:{...lastGood.cpu,loadPercent:load.total,perCorePercent:load.perCore},memory:{...lastGood.memory,totalBytes:total,usedBytes:used,freeBytes:free,availableBytes:free,usedPercent:memoryPercent}};
  const cpu=os.cpus()[0];
  return{collectedAt:now,platform:process.platform,hostname:os.hostname(),cpuPercent:load.total,memoryPercent,uptimeSeconds:Math.round(os.uptime()),cpu:{manufacturer:'',model:cpu?.model?.trim()||'Processor',physicalCores:os.cpus().length,logicalCores:os.cpus().length,speedGHz:cpu?.speed?Math.round(cpu.speed/100)/10:null,loadPercent:load.total,userPercent:0,systemPercent:0,perCorePercent:load.perCore,temperatureC:null,maxTemperatureC:null},memory:{totalBytes:total,usedBytes:used,freeBytes:free,availableBytes:free,swapTotalBytes:0,swapUsedBytes:0,usedPercent:memoryPercent},gpus:[],disks:[],diskIo:{readBytesPerSecond:null,writeBytesPerSecond:null,readOperationsPerSecond:null,writeOperationsPerSecond:null,utilizationPercent:null},networks:[],battery:{present:false,percent:null,charging:false,acConnected:true,timeRemainingMinutes:null,cycleCount:null,healthPercent:null},processes:{all:0,running:0,blocked:0,sleeping:0,topCpu:[],topMemory:[]},system:{manufacturer:'',model:'',os:process.platform,release:os.release(),architecture:os.arch(),virtual:false},availability:{cpuTemperature:false,gpuLoad:false,gpuTemperature:false,diskIo:false,networkThroughput:false,battery:false},warnings:['Extended hardware sensors are initializing in the background.']};
}

async function staticSnapshot():Promise<StaticSnapshot>{
  if(staticCache&&Date.now()-staticCacheAt<10*60_000)return staticCache;
  const [system,cpu,osInfo,graphics,networkInterfaces]=await Promise.all([si.system(),si.cpu(),si.osInfo(),si.graphics(),si.networkInterfaces()]);
  staticCache={system,cpu,os:osInfo,graphics,networkInterfaces:Array.isArray(networkInterfaces)?networkInterfaces:[networkInterfaces]};
  staticCacheAt=Date.now();
  return staticCache;
}

async function collect():Promise<SystemTelemetry>{
  const warnings:string[]=[];
  const staticResult=await Promise.allSettled([staticSnapshot()]);
  const base=settled(staticResult[0]);
  if(!base)warnings.push('Hardware identity is temporarily unavailable.');
  const dynamic=await Promise.allSettled([si.currentLoad(),si.mem(),si.cpuTemperature(),si.graphics(),si.fsSize(),si.disksIO(),si.fsStats(),si.networkStats(),si.battery(),si.processes(),nvidiaTelemetry()]);
  const load=settled(dynamic[0]),memory=settled(dynamic[1]),temperature=settled(dynamic[2]),graphics=settled(dynamic[3])??base?.graphics,filesystems=settled(dynamic[4]),diskIo=settled(dynamic[5]),fileIo=settled(dynamic[6]),networkStats=settled(dynamic[7]),battery=settled(dynamic[8]),processes=settled(dynamic[9]),nvidia=settled(dynamic[10])??[];
  const cpuTemperature=usefulTemperature(temperature?.main);
  const maxCpuTemperature=usefulTemperature(temperature?.max)??(temperature?.cores.map(usefulTemperature).filter((value):value is number=>value!==null).sort((a,b)=>b-a)[0]??cpuTemperature);
  if(!cpuTemperature)warnings.push('CPU temperature is not exposed by this operating system or hardware sensor.');

  const gpus:GpuTelemetry[]=(graphics?.controllers??[]).slice(0,8).map((gpu)=>{const model=String(gpu.model||gpu.name||'Graphics controller'),native=nvidia.find((item)=>model.toLowerCase().includes(item.model.toLowerCase())||item.model.toLowerCase().includes(model.toLowerCase()));return{
    vendor:String(gpu.vendor||'Unknown'),model,vramMB:finite(gpu.vram)??native?.memoryTotalMB??null,
    loadPercent:native?.loadPercent??(finite(gpu.utilizationGpu)===null?null:percent(gpu.utilizationGpu)),memoryUsedMB:native?.memoryUsedMB??finite(gpu.memoryUsed),memoryTotalMB:native?.memoryTotalMB??finite(gpu.memoryTotal),
    temperatureC:native?.temperatureC??usefulTemperature(gpu.temperatureGpu),fanPercent:native?.fanPercent??(finite(gpu.fanSpeed)===null?null:percent(gpu.fanSpeed)),
    powerWatts:native?.powerWatts??(finite(gpu.powerDraw)===null?null:Math.round(positive(gpu.powerDraw)*10)/10),driver:native?.driver||String(gpu.driverVersion||''),
  };});
  if(gpus.length&&!gpus.some((gpu)=>gpu.loadPercent!==null))warnings.push('GPU utilization is not exposed by the installed graphics driver.');
  if(gpus.length&&!gpus.some((gpu)=>gpu.temperatureC!==null))warnings.push('GPU temperature is not exposed by the installed graphics driver.');

  const disks:DiskTelemetry[]=(filesystems??[]).filter((disk)=>positive(disk.size)>0).slice(0,12).map((disk)=>({mount:String(disk.mount||disk.fs),filesystem:String(disk.fs||''),type:String(disk.type||''),totalBytes:positive(disk.size),usedBytes:positive(disk.used),availableBytes:positive(disk.available),usedPercent:percent(disk.use)}));
  const statsMap=new Map((networkStats??[]).map((item)=>[interfaceKey(item.iface),item]));
  const networks:NetworkTelemetry[]=(base?.networkInterfaces??[]).filter((item)=>!item.internal&&(item.default||item.operstate==='up'||Boolean(item.ip4))).slice(0,8).map((detail)=>{const item=statsMap.get(interfaceKey(detail.iface));return{interface:detail.iface,type:String(detail.type||''),ip4:String(detail.ip4||''),default:Boolean(detail.default),state:item?.operstate||detail.operstate||'unknown',speedMbps:finite(detail.speed),rxBytesPerSecond:finite(item?.rx_sec),txBytesPerSecond:finite(item?.tx_sec)};});
  const sortedCpu=[...(processes?.list??[])].filter((item)=>item.pid>0&&item.name).sort((a,b)=>positive(b.cpu)-positive(a.cpu)).slice(0,6).map(processView);
  const sortedMemory=[...(processes?.list??[])].filter((item)=>item.pid>0&&item.name).sort((a,b)=>positive(b.mem)-positive(a.mem)).slice(0,6).map(processView);
  const totalMemory=positive(memory?.total)||os.totalmem(),usedMemory=positive(memory?.active)||positive(memory?.used)||(totalMemory-os.freemem());
  const memoryPercent=totalMemory?percent(usedMemory/totalMemory*100):0;
  const gpuLoadAvailable=gpus.some((gpu)=>gpu.loadPercent!==null),gpuTemperatureAvailable=gpus.some((gpu)=>gpu.temperatureC!==null);
  const batteryHealth=battery?.hasBattery&&positive(battery.designedCapacity)>0?percent(positive(battery.maxCapacity)/positive(battery.designedCapacity)*100):null;

  return{
    collectedAt:new Date().toISOString(),platform:process.platform,hostname:base?.os.hostname||os.hostname(),
    cpuPercent:percent(load?.currentLoad),memoryPercent,uptimeSeconds:Math.round(os.uptime()),
    cpu:{manufacturer:String(base?.cpu.manufacturer||''),model:String(base?.cpu.brand||os.cpus()[0]?.model||'Processor'),physicalCores:Math.round(positive(base?.cpu.physicalCores)||os.cpus().length),logicalCores:Math.round(positive(base?.cpu.cores)||os.cpus().length),speedGHz:finite(base?.cpu.speed),loadPercent:percent(load?.currentLoad),userPercent:percent(load?.currentLoadUser),systemPercent:percent(load?.currentLoadSystem),perCorePercent:(load?.cpus??[]).map((core)=>percent(core.load)).slice(0,128),temperatureC:cpuTemperature,maxTemperatureC:maxCpuTemperature},
    memory:{totalBytes:totalMemory,usedBytes:usedMemory,freeBytes:positive(memory?.free)||os.freemem(),availableBytes:positive(memory?.available)||os.freemem(),swapTotalBytes:positive(memory?.swaptotal),swapUsedBytes:positive(memory?.swapused),usedPercent:memoryPercent},
    gpus,disks,
    diskIo:{readBytesPerSecond:finite(fileIo?.rx_sec),writeBytesPerSecond:finite(fileIo?.wx_sec),readOperationsPerSecond:finite(diskIo?.rIO_sec),writeOperationsPerSecond:finite(diskIo?.wIO_sec),utilizationPercent:finite(diskIo?.tWaitPercent)===null?null:percent(diskIo?.tWaitPercent)},
    networks,
    battery:{present:Boolean(battery?.hasBattery),percent:battery?.hasBattery?percent(battery.percent):null,charging:Boolean(battery?.isCharging),acConnected:Boolean(battery?.acConnected),timeRemainingMinutes:battery?.hasBattery&&finite(battery.timeRemaining)!==null?Math.max(0,Math.round(battery.timeRemaining)):null,cycleCount:battery?.hasBattery&&finite(battery.cycleCount)!==null?Math.max(0,Math.round(battery.cycleCount)):null,healthPercent:batteryHealth},
    processes:{all:Math.round(positive(processes?.all)),running:Math.round(positive(processes?.running)),blocked:Math.round(positive(processes?.blocked)),sleeping:Math.round(positive(processes?.sleeping)),topCpu:sortedCpu,topMemory:sortedMemory},
    system:{manufacturer:String(base?.system.manufacturer||''),model:String(base?.system.model||''),os:String(base?.os.distro||process.platform),release:String(base?.os.release||os.release()),architecture:String(base?.os.arch||os.arch()),virtual:Boolean(base?.system.virtual)},
    availability:{cpuTemperature:cpuTemperature!==null,gpuLoad:gpuLoadAvailable,gpuTemperature:gpuTemperatureAvailable,diskIo:Boolean(diskIo||fileIo),networkThroughput:networks.some((item)=>item.rxBytesPerSecond!==null||item.txBytesPerSecond!==null),battery:Boolean(battery?.hasBattery)},
    warnings,
  };
}

export async function getSystemTelemetrySnapshot(options:{detailed?:boolean}={}):Promise<SystemTelemetry>{
  if(!inFlight&&(!lastGood||Date.now()-lastExtendedAt>30_000)){
    inFlight=collect().then((snapshot)=>{lastGood=snapshot;lastExtendedAt=Date.now();return snapshot;}).catch((reason)=>{
      if(lastGood){lastGood={...lastGood,collectedAt:new Date().toISOString(),warnings:[...lastGood.warnings.filter((warning)=>!warning.startsWith('Telemetry refresh failed:')),`Telemetry refresh failed: ${reason instanceof Error?reason.message:String(reason)}`]};return lastGood;}
      return quickSnapshot();
    }).finally(()=>{inFlight=undefined;});
  }
  if(options.detailed&&inFlight)return inFlight;
  return quickSnapshot();
}

export function resetSystemTelemetryCache():void{staticCache=undefined;staticCacheAt=0;lastGood=undefined;lastExtendedAt=0;inFlight=undefined;previousCpu=os.cpus().map((cpu)=>({idle:cpu.times.idle,total:Object.values(cpu.times).reduce((sum,value)=>sum+value,0)}));}
