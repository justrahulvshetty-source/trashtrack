require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SUPABASE ───
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const resend = process.env.RESEND_KEY ? new Resend(process.env.RESEND_KEY) : null;

// ─── ADMIN AUTH ───
const adminSessions = new Set();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'trashtrack2026';

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminSessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  setTimeout(() => adminSessions.delete(token), 24 * 60 * 60 * 1000);
  res.json({ ok: true, token });
});

// ─── GEO UTILS ───
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeVehicle(vn) {
  return (vn || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ─── WARD API ───
app.get('/api/wards', async (req, res) => {
  const { data, error } = await supabase.from('wards').select('*').order('ward_number');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── TRUCK / DRIVER APIs ───

// Add truck (admin)
app.post('/api/admin/truck', requireAdmin, async (req, res) => {
  const { vehicleNumber, driverName, driverPhone, wardId } = req.body;
  if (!vehicleNumber || !driverName) return res.status(400).json({ error: 'Vehicle number and driver name required' });

  const vn = normalizeVehicle(vehicleNumber);
  const { data: existing } = await supabase.from('trucks').select('id').eq('vehicle_normalized', vn).single();
  if (existing) return res.status(409).json({ error: 'Vehicle already registered' });

  const { data, error } = await supabase.from('trucks').insert({
    vehicle_number: vehicleNumber.toUpperCase().trim(),
    vehicle_normalized: vn,
    driver_name: driverName,
    driver_phone: driverPhone || null,
    ward_id: wardId || null,
    is_active: false
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  console.log(`🚛 Truck added: ${driverName} (${vehicleNumber})`);
  res.json({ ok: true, truck: data });
});

// Delete truck (admin)
app.delete('/api/admin/truck/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('trucks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Driver: start shift
app.post('/api/driver/start', async (req, res) => {
  const { vehicleNumber } = req.body;
  if (!vehicleNumber) return res.status(400).json({ error: 'Missing vehicleNumber' });

  const vn = normalizeVehicle(vehicleNumber);
  const { data: truck, error } = await supabase.from('trucks')
    .update({ is_active: true, current_lat: 0, current_lng: 0, last_update: new Date().toISOString() })
    .eq('vehicle_normalized', vn)
    .select().single();

  if (error || !truck) return res.status(404).json({ error: 'Vehicle not found' });

  // Reset daily alerts for subscribers of this truck
  await supabase.from('subscribers')
    .update({ whatsapp_sent: false, call_sent: false })
    .eq('vehicle_number', truck.vehicle_number);

  io.emit('shift-started', { vehicleNumber: truck.vehicle_number });
  console.log(`🟢 ${truck.driver_name} (${truck.vehicle_number}) started shift`);
  res.json({ ok: true, truck });
});

// Driver: end shift
app.post('/api/driver/end', async (req, res) => {
  const vn = normalizeVehicle(req.body.vehicleNumber);
  const { data: truck, error } = await supabase.from('trucks')
    .update({ is_active: false })
    .eq('vehicle_normalized', vn)
    .select().single();

  if (error || !truck) return res.status(404).json({ error: 'Vehicle not found' });

  io.emit('shift-ended', { vehicleNumber: truck.vehicle_number });
  console.log(`🔴 ${truck.driver_name} (${truck.vehicle_number}) ended shift`);
  res.json({ ok: true });
});

// Driver: update location
app.post('/api/driver/location', async (req, res) => {
  const { vehicleNumber, lat, lng } = req.body;
  if (!vehicleNumber || !lat || !lng) return res.status(400).json({ error: 'Missing fields' });

  const vn = normalizeVehicle(vehicleNumber);
  const { data: truck, error } = await supabase.from('trucks')
    .update({ current_lat: lat, current_lng: lng, last_update: new Date().toISOString(), is_active: true })
    .eq('vehicle_normalized', vn)
    .select().single();

  if (error || !truck) return res.status(404).json({ error: 'Vehicle not found' });

  // Broadcast location
  io.emit('truck-location', {
    vehicleNumber: truck.vehicle_number,
    lat, lng,
    driverName: truck.driver_name,
    lastUpdate: truck.last_update
  });

  // Check alerts
  await checkAlerts(truck, lat, lng);

  res.json({ ok: true });
});

// Get truck info (public)
app.get('/api/truck/:vehicleNumber', async (req, res) => {
  const vn = normalizeVehicle(req.params.vehicleNumber);
  const { data, error } = await supabase.from('trucks')
    .select('*, wards(name, ward_number, zone)')
    .eq('vehicle_normalized', vn)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(data);
});

// Check if vehicle exists (public)
app.get('/api/vehicle/:vehicleNumber', async (req, res) => {
  const vn = normalizeVehicle(req.params.vehicleNumber);
  const { data } = await supabase.from('trucks')
    .select('vehicle_number, driver_name, ward_id, is_active, wards(name)')
    .eq('vehicle_normalized', vn)
    .single();

  if (!data) return res.status(404).json({ found: false });
  res.json({ found: true, ...data });
});

// ─── SUBSCRIBER APIs ───

app.post('/api/subscribe', async (req, res) => {
  const { name, phone, lat, lng, vehicleNumber, apartment } = req.body;
  if (!name || !phone || !lat || !lng || !vehicleNumber) return res.status(400).json({ error: 'Missing fields' });

  // Verify truck exists
  const vn = normalizeVehicle(vehicleNumber);
  const { data: truck } = await supabase.from('trucks').select('*').eq('vehicle_normalized', vn).single();
  if (!truck) return res.status(404).json({ error: 'Vehicle not tracked' });

  // Check duplicate
  const { data: existing } = await supabase.from('subscribers')
    .select('id').eq('phone', phone).eq('vehicle_number', truck.vehicle_number).single();
  if (existing) return res.status(409).json({ error: 'Already subscribed' });

  const { data, error } = await supabase.from('subscribers').insert({
    name, phone, lat, lng,
    vehicle_number: truck.vehicle_number,
    ward_id: truck.ward_id,
    apartment: apartment || null,
    active: true
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  console.log(`✅ Subscriber: ${name} (${phone}) → ${truck.vehicle_number}`);
  res.json({ ok: true, subscriber: data });
});

app.get('/api/subscriber/:id', async (req, res) => {
  const { data, error } = await supabase.from('subscribers').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// ─── ALERT LOGIC ───
async function checkAlerts(truck, truckLat, truckLng) {
  const { data: subscribers } = await supabase.from('subscribers')
    .select('*')
    .eq('vehicle_number', truck.vehicle_number)
    .eq('active', true);

  if (!subscribers || subscribers.length === 0) return;

  for (const sub of subscribers) {
    const dist = haversine(truckLat, truckLng, sub.lat, sub.lng);

    // WhatsApp at 3km
    if (dist <= 3000 && !sub.whatsapp_sent) {
      const eta = Math.max(1, Math.round((dist / 1000) / 15 * 60));
      console.log(`📱 WhatsApp → ${sub.phone}: truck ${truck.vehicle_number} is ${Math.round(dist)}m away, ETA ${eta}min`);

      await supabase.from('alerts_log').insert({
        type: 'whatsapp',
        subscriber_id: sub.id,
        truck_id: truck.id,
        distance: Math.round(dist),
        message: `Truck ${truck.vehicle_number} is ${(dist/1000).toFixed(1)}km away. ETA ~${eta}min`
      });

      await supabase.from('subscribers').update({ whatsapp_sent: true }).eq('id', sub.id);
      io.emit('alert-triggered', { type: 'whatsapp', subscriberName: sub.name, phone: sub.phone, distance: Math.round(dist) });
    }

    // Call at 500m
    if (dist <= 500 && !sub.call_sent) {
      console.log(`📞 Call → ${sub.phone}: truck ${truck.vehicle_number} is ${Math.round(dist)}m away`);

      await supabase.from('alerts_log').insert({
        type: 'call',
        subscriber_id: sub.id,
        truck_id: truck.id,
        distance: Math.round(dist),
        message: `Truck ${truck.vehicle_number} is approaching — ${Math.round(dist)}m away`
      });

      await supabase.from('subscribers').update({ call_sent: true }).eq('id', sub.id);
      io.emit('alert-triggered', { type: 'call', subscriberName: sub.name, phone: sub.phone, distance: Math.round(dist) });
    }
  }
}

// ─── DEMO MODE ───
let demoInterval = null;
let demoStep = 0;

// Real Bangalore route: Koramangala to Bellandur
const demoRoute = [
  [12.9352, 77.6245], [12.9340, 77.6290], [12.9325, 77.6340],
  [12.9310, 77.6390], [12.9300, 77.6440], [12.9290, 77.6490],
  [12.9280, 77.6540], [12.9270, 77.6590], [12.9265, 77.6640],
  [12.9260, 77.6690], [12.9255, 77.6740], [12.9250, 77.6760]
];

app.post('/api/admin/demo/start', requireAdmin, async (req, res) => {
  if (demoInterval) return res.json({ ok: true, message: 'Demo already running' });

  // Create or get demo truck
  const vn = 'KA01DEMO001';
  let { data: truck } = await supabase.from('trucks').select('*').eq('vehicle_normalized', vn).single();

  if (!truck) {
    const { data: ward } = await supabase.from('wards').select('id').eq('ward_number', '85').single();
    const { data } = await supabase.from('trucks').insert({
      vehicle_number: 'KA-01-DEMO-001',
      vehicle_normalized: vn,
      driver_name: 'Demo Driver',
      driver_phone: '0000000000',
      ward_id: ward ? ward.id : null,
      is_active: true
    }).select().single();
    truck = data;
  } else {
    await supabase.from('trucks').update({ is_active: true }).eq('id', truck.id);
  }

  demoStep = 0;
  io.emit('shift-started', { vehicleNumber: 'KA-01-DEMO-001' });

  demoInterval = setInterval(async () => {
    if (demoStep >= demoRoute.length) {
      demoStep = 0; // Loop
    }

    const [lat, lng] = demoRoute[demoStep];
    await supabase.from('trucks').update({
      current_lat: lat, current_lng: lng,
      last_update: new Date().toISOString()
    }).eq('vehicle_normalized', vn);

    io.emit('truck-location', {
      vehicleNumber: 'KA-01-DEMO-001',
      lat, lng,
      driverName: 'Demo Driver',
      lastUpdate: new Date().toISOString()
    });

    // Check alerts
    const { data: truckData } = await supabase.from('trucks').select('*').eq('vehicle_normalized', vn).single();
    if (truckData) await checkAlerts(truckData, lat, lng);

    demoStep++;
  }, 3000);

  console.log('🎬 Demo mode started');
  res.json({ ok: true, vehicleNumber: 'KA-01-DEMO-001' });
});

app.post('/api/admin/demo/stop', requireAdmin, async (req, res) => {
  if (demoInterval) {
    clearInterval(demoInterval);
    demoInterval = null;
  }
  await supabase.from('trucks').update({ is_active: false }).eq('vehicle_normalized', 'KA01DEMO001');
  io.emit('shift-ended', { vehicleNumber: 'KA-01-DEMO-001' });
  console.log('🎬 Demo mode stopped');
  res.json({ ok: true });
});

// ─── ADMIN STATS ───
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const { data: trucks } = await supabase.from('trucks').select('*, wards(name, ward_number)');
  const { data: subscribers } = await supabase.from('subscribers').select('*').eq('active', true);
  const { data: alerts } = await supabase.from('alerts_log').select('*').order('sent_at', { ascending: false }).limit(30);
  const { data: wards } = await supabase.from('wards').select('*');

  const activeTrucks = (trucks || []).filter(t => t.is_active);

  res.json({
    totalTrucks: (trucks || []).length,
    activeTrucks: activeTrucks.length,
    totalSubscribers: (subscribers || []).length,
    alertsToday: (alerts || []).length,
    revenue: (subscribers || []).length * 100,
    trucks: trucks || [],
    subscribers: subscribers || [],
    alerts: alerts || [],
    wards: wards || [],
    demoRunning: demoInterval !== null
  });
});

// ─── WAITLIST (for landing page) ───
app.post('/api/waitlist', async (req, res) => {
  const { name, phone, email, area, complexName } = req.body;
  if (!name || !area) return res.status(400).json({ error: 'Missing fields' });
  const fullArea = complexName ? area + ' | ' + complexName : area;
  const { error } = await supabase.from('waitlist').insert({ name, phone: phone || null, email: email || null, area: fullArea });
  if (error) return res.status(500).json({ error: error.message });
  if (resend && email) {
    try { await resend.emails.send({ from: 'TrashTrack <onboarding@resend.dev>', to: email, subject: 'You are on the TrashTrack waitlist', html: '<h1 style="color:#00D084">You are in, '+name+'!</h1><p>We are building TrashTrack for <b>'+fullArea+'</b>. We will WhatsApp you when we go live in your area.</p>' }); console.log('Email sent to '+email); } catch(e) { console.log('Email err: '+e.message); }
    try { await resend.emails.send({ from: 'TrashTrack <onboarding@resend.dev>', to: 'info.trashtrack@gmail.com', subject: 'New signup: '+name+' from '+fullArea, html: '<h2 style="color:#00D084">New Signup</h2><p>Name: '+name+'</p><p>Email: '+(email||'NA')+'</p><p>Area: '+fullArea+'</p>' }); } catch(e) {}
  }
  console.log('Waitlist: '+name+' - '+fullArea);
  res.json({ ok: true });
});

app.get('/api/waitlist/count', async (req, res) => {
  const { count } = await supabase.from('waitlist').select('*', { count: 'exact', head: true });
  res.json({ count: count || 0 });
});

// ─── PAGE ROUTES ───
app.get('/driver/:vn', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));
app.get('/track/:vn', (req, res) => res.sendFile(path.join(__dirname, 'public', 'track.html')));
app.get('/track', (req, res) => res.sendFile(path.join(__dirname, 'public', 'track.html')));
app.get('/subscribe', (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscribe.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/ward/:wn', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ward.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── SOCKET.IO ───
io.on('connection', (socket) => {
  console.log('👤 Connected:', socket.id);
});

// ─── DAILY RESET (5 AM IST) ───
setInterval(async () => {
  const now = new Date();
  const istHour = (now.getUTCHours() + 5) % 24;
  const istMin = (now.getUTCMinutes() + 30) % 60;
  if (istHour === 5 && istMin === 0) {
    await supabase.from('subscribers').update({ whatsapp_sent: false, call_sent: false }).eq('active', true);
    console.log('🔄 Daily alert reset');
  }
}, 60000);

// ─── START ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║          🚛 TrashTrack Server            ║
╠══════════════════════════════════════════╣
║  Port: ${PORT}                              ║
║  DB: Supabase                            ║
║                                          ║
║  /admin     — Dashboard (protected)      ║
║  /driver/:vn — Driver GPS page           ║
║  /track/:vn  — Live tracking             ║
║  /subscribe  — Customer onboarding       ║
║  /ward/:wn   — Ward public view          ║
╚══════════════════════════════════════════╝
  `);
});
