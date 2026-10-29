'use strict';
/**
 * Opens the Skyrim Together server port on the home router with UPnP (IGD), and tells whether a home
 * server can work at all: behind carrier-grade NAT (CGNAT) no port forward reaches you.
 */
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const { XMLParser } = require('fast-xml-parser');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const WAN_SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

/** Parses an SSDP reply's headers (case-insensitive keys). */
function parseSsdp(text) {
  const headers = {};
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/** Finds the WAN connection service's control URL in a router's device description XML. */
function findControlUrl(xml, location) {
  const doc = new XMLParser({ ignoreAttributes: true, isArray: n => n === 'service' || n === 'device' }).parse(xml);
  const services = [];
  const walk = dev => {
    for (const d of [].concat(dev || [])) {
      for (const s of [].concat((d.serviceList && d.serviceList.service) || [])) services.push(s);
      if (d.deviceList) walk(d.deviceList.device);
    }
  };
  walk(doc.root && doc.root.device);
  for (const type of WAN_SERVICES) {
    const s = services.find(x => x.serviceType === type);
    if (s && s.controlURL) return { url: new URL(String(s.controlURL), (doc.root && doc.root.URLBase) || location).toString(), serviceType: type };
  }
  return null;
}

/** 100.64.0.0/10 is reserved for carrier-grade NAT; private ranges on the WAN side mean double NAT. */
function classifyWanIp(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return 'unknown';
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'cgnat';
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return 'double-nat';
  return 'public';
}

function discover(timeoutMs = 3000) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    const msg = Buffer.from([
      'M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2',
      'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1', '', '',
    ].join('\r\n'));
    sock.on('message', (buf, rinfo) => {
      const h = parseSsdp(buf.toString());
      if (h.location && !found.has(h.location)) found.set(h.location, { location: h.location, from: rinfo.address });
    });
    sock.on('error', () => {});
    sock.bind(() => {
      try { sock.send(msg, SSDP_PORT, SSDP_ADDR); sock.send(msg, SSDP_PORT, SSDP_ADDR); } catch {}
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs);
  });
}

function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => { b += d; if (b.length > 1 << 20) req.destroy(new Error('Too large')); });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Router did not answer')));
    if (body) req.write(body);
    req.end();
  });
}

async function soap(control, action, args = {}) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${control.serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const r = await httpRequest(control.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${control.serviceType}#${action}"`, 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (r.status !== 200) {
    const code = (r.body.match(/<errorCode>(\d+)<\/errorCode>/) || [])[1];
    const desc = (r.body.match(/<errorDescription>([^<]*)<\/errorDescription>/) || [])[1];
    throw new Error(`Router refused ${action}${code ? ` (${code}${desc ? `: ${desc}` : ''})` : ''}`);
  }
  return r.body;
}

/** The LAN address of this PC on the router's network. */
function localAddressFor(routerIp) {
  const prefix = String(routerIp).split('.').slice(0, 3).join('.') + '.';
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) all.push(i.address);
  return all.find(a => a.startsWith(prefix)) || all[0] || null;
}

async function findRouter() {
  const devices = await discover();
  for (const d of devices) {
    try {
      const desc = await httpRequest(d.location);
      const control = findControlUrl(desc.body, d.location);
      if (control) return { ...control, routerIp: d.from };
    } catch {}
  }
  return null;
}

/** Checks the router: reachable, its WAN address and what that means for hosting. */
async function status(port) {
  const router = await findRouter();
  if (!router) return { router: false };
  let wanIp = null;
  try { wanIp = ((await soap(router, 'GetExternalIPAddress')).match(/<NewExternalIPAddress>([^<]*)</) || [])[1] || null; } catch {}
  let mapped = false;
  try {
    const r = await soap(router, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'UDP' });
    mapped = /<NewInternalClient>/.test(r);
  } catch {}
  return { router: true, routerIp: router.routerIp, localIp: localAddressFor(router.routerIp), wanIp, wan: classifyWanIp(wanIp), mapped };
}

async function openPort(port) {
  const router = await findRouter();
  if (!router) throw new Error('No UPnP router found. Turn on UPnP in your router settings, or forward the port by hand.');
  const client = localAddressFor(router.routerIp);
  await soap(router, 'AddPortMapping', {
    NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'UDP', NewInternalPort: port, NewInternalClient: client,
    NewEnabled: 1, NewPortMappingDescription: 'STR Companion (Skyrim Together server)', NewLeaseDuration: 0,
  });
  return { port, client };
}

async function closePort(port) {
  const router = await findRouter();
  if (!router) throw new Error('No UPnP router found.');
  await soap(router, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'UDP' });
  return { port };
}

module.exports = { parseSsdp, findControlUrl, classifyWanIp, status, openPort, closePort };
