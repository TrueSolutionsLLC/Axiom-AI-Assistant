export interface CameraRequestIntent { showFeed:boolean; analyze:boolean; deviceName?:string; }

const fillerWord=/^(?:me|the|my|a|an|live|visible)\s+/i;

// "cam" (short for camera — "front door cam", "back door cam") is extremely
// common colloquial phrasing and was previously not recognized at all,
// since \bcamera\b requires the full word. \bcams?\b is a safe separate
// alternative — it won't match inside "camera" (no word boundary between
// "cam" and "era").
const cameraWord=/\bcams?\b|\bcameras?\b|\bwebcams?\b/;

export function cameraRequestIntent(text:string):CameraRequestIntent{
  const clean=text.toLowerCase().replace(/\s+/g,' ').trim();
  const camera=cameraWord.test(clean)||/\b(video feed|room feed|camera feed)\b/.test(clean);
  if(!camera)return{showFeed:false,analyze:false};
  const showFeed=/\b(show|open|display|view|watch|pull up|bring up|turn on|enable)\b.{0,36}\b(cams?|cameras?|webcams?|feed)\b|\b(cams?|cameras?|webcams?|video feed|camera feed)\b.{0,36}\b(show|open|display|view|live|on)\b/.test(clean)||/\b(camera|video) feed\b/.test(clean);
  const analyze=/\b(can|do) you see\b|\bsee me\b|\blook (?:at|through|using)\b|\bwhat (?:do|am|is|are|can)\b|\bwho (?:is|are)\b|\bdescribe\b|\bidentify\b|\bwearing\b|\bdoing\b|\brecognize\b/.test(clean);
  // Bare "show me the camera"/"show the webcam" has no device to name — that
  // stays routed to the local webcam exactly as before. Only a named target
  // like "the front door camera" should ever be treated as a specific
  // (e.g. Ring) camera; App.tsx decides the actual routing, this stays a
  // pure parser.
  const deviceMatch=clean.match(/\b(?:show|open|display|view|watch|pull up|bring up|turn on|enable)\b\s+(.+?)\s*\b(?:cams?|cameras?|webcams?|video feed|camera feed|feed)\b/);
  let deviceName=deviceMatch?.[1]?.replace(fillerWord,'').replace(fillerWord,'').trim();
  if(deviceName&&/^(?:me|the|my|a|an|live|visible)$/i.test(deviceName))deviceName='';
  return{showFeed,analyze,deviceName:deviceName||undefined};
}
