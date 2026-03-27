const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log('🔌 Connecting to Supabase:', process.env.SUPABASE_URL);

app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500', '*'],
  credentials: true
}));
app.use(express.json());

// ============ MIDDLEWARE ============
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const { data: staff, error } = await supabase
      .from('staff')
      .select('id, email, name, role, department_id')
      .eq('id', decoded.userId)
      .single();

    if (error || !staff) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = staff;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    supabase: process.env.SUPABASE_URL ? 'Connected' : 'Not configured'
  });
});

// ============ WELCOME PAGE ============
app.get('/', (req, res) => {
  res.json({
    name: 'pehia Queue Management API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: 'GET /health',
      login: 'POST /api/auth/login',
      register: 'POST /api/patients/register',
      patients: 'GET /api/patients',
      tokens: 'GET /api/tokens',
      departments: 'GET /api/departments',
      analytics: 'GET /api/analytics/dashboard',
      staff: 'GET /api/staff'
    }
  });
});

// ============ AUTH LOGIN ============
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('\n=================================');
    console.log('🔐 LOGIN ATTEMPT');
    console.log('📧 Email:', email);
    console.log('=================================\n');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data: staff, error } = await supabase
      .from('staff')
      .select('id, email, name, role, password_hash, department_id')
      .eq('email', email)
      .single();

    if (error || !staff) {
      console.log('❌ Staff not found:', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    console.log('✅ Staff found:', staff.name);
    console.log('📝 Stored password:', staff.password_hash);

    const isValid = (password === staff.password_hash);
    
    if (!isValid) {
      console.log('❌ Invalid password for:', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await supabase
      .from('staff')
      .update({ last_login: new Date().toISOString() })
      .eq('id', staff.id);

    let department = null;
    if (staff.department_id) {
      const { data: dept } = await supabase
        .from('departments')
        .select('name, code')
        .eq('id', staff.department_id)
        .single();
      department = dept;
    }

    const token = jwt.sign(
      { userId: staff.id, email: staff.email, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    console.log('✅ Login successful for:', email);
    console.log('=================================\n');
    
    res.json({
      token,
      user: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        department
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ PATIENT REGISTRATION ============
app.post('/api/patients/register', authenticateToken, async (req, res) => {
  try {
    const { 
      first_name, 
      last_name, 
      date_of_birth, 
      phone, 
      email, 
      department_id, 
      doctor_id, 
      notes,
      priority = 'normal' 
    } = req.body;

    console.log('\n📝 Registering patient:', first_name, last_name);

    if (!first_name || !last_name || !date_of_birth || !phone || !department_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if patient exists
    let { data: existingPatient } = await supabase
      .from('patients')
      .select('id')
      .eq('phone', phone)
      .single();

    let patientId;

    if (existingPatient) {
      patientId = existingPatient.id;
      console.log('Existing patient found:', patientId);
    } else {
      const { data: patient, error: patientError } = await supabase
        .from('patients')
        .insert({
          first_name,
          last_name,
          date_of_birth,
          phone,
          email: email || null,
          created_by: req.user.id,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (patientError) throw patientError;
      patientId = patient.id;
      console.log('New patient created:', patientId);
    }

    // Get department info
    const { data: department, error: deptError } = await supabase
      .from('departments')
      .select('id, code, avg_wait_time, name')
      .eq('id', department_id)
      .single();

    if (deptError) throw deptError;

    // Get today's tokens count
    const today = new Date().toISOString().split('T')[0];
    const { data: todayTokens, count: tokenCount } = await supabase
      .from('tokens')
      .select('id', { count: 'exact', head: true })
      .eq('department_id', department_id)
      .gte('created_at', today);

    const nextNumber = (tokenCount || 0) + 1;
    const tokenNumber = `${department.code}-${String(nextNumber).padStart(4, '0')}`;
    
    const priorityScores = { emergency: 100, vip: 80, senior: 60, normal: 40 };
    const priorityScore = priorityScores[priority] || 40;
    const counterNumber = Math.floor(Math.random() * 5) + 1;

    // Create token with all fields properly set
    const { data: token, error: tokenError } = await supabase
      .from('tokens')
      .insert({
        token_number: tokenNumber,
        patient_id: patientId,
        department_id: department_id,
        staff_id: doctor_id || null,
        priority: priority,
        priority_score: priorityScore,
        status: 'waiting',
        counter_number: counterNumber,
        estimated_wait_time: department.avg_wait_time,
        actual_wait_time: null,
        called_at: null,
        started_at: null,
        completed_at: null,
        cancelled_at: null,
        cancellation_reason: null,
        created_at: new Date().toISOString()
      })
      .select(`
        *,
        patient:patient_id(first_name, last_name, phone),
        department:department_id(id, name, code),
        staff:staff_id(id, name)
      `)
      .single();

    if (tokenError) throw tokenError;

    // Log to queue_log
    await supabase
      .from('queue_log')
      .insert({
        token_id: token.id,
        department_id: department_id,
        action: 'created',
        previous_status: null,
        new_status: 'waiting',
        wait_time_before_action: null,
        performed_by: req.user.id,
        timestamp: new Date().toISOString()
      });

    console.log('✅ Token generated:', tokenNumber);
    console.log('=================================\n');

    res.json({
      message: 'Patient registered successfully',
      patient: { id: patientId, name: `${first_name} ${last_name}` },
      token: {
        id: token.id,
        token_number: token.token_number,
        status: token.status,
        counter_number: token.counter_number,
        estimated_wait_time: token.estimated_wait_time,
        department: token.department,
        doctor: token.staff,
        patient: token.patient
      }
    });
  } catch (error) {
    console.error('❌ Error registering patient:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ GET PATIENTS ============
app.get('/api/patients', authenticateToken, async (req, res) => {
  try {
    const { search } = req.query;
    let query = supabase.from('patients').select('*');

    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching patients:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ GET TOKENS ============
app.get('/api/tokens', authenticateToken, async (req, res) => {
  try {
    const { department, status } = req.query;
    let query = supabase
      .from('tokens')
      .select(`
        *,
        patient:patient_id(first_name, last_name, phone),
        department:department_id(id, name, code),
        staff:staff_id(id, name)
      `);

    if (department) query = query.eq('department_id', department);
    if (status) query = query.eq('status', status);

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ UPDATE TOKEN STATUS ============
app.patch('/api/tokens/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    const { data: currentToken, error: fetchError } = await supabase
      .from('tokens')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const updateData = { status, updated_at: new Date().toISOString() };
    const now = new Date().toISOString();

    switch (status) {
      case 'called':
        updateData.called_at = now;
        break;
      case 'in-progress':
        updateData.started_at = now;
        break;
      case 'completed':
        updateData.completed_at = now;
        if (currentToken.created_at) {
          const createdTime = new Date(currentToken.created_at);
          const completedTime = new Date(now);
          const waitTimeMinutes = Math.round((completedTime - createdTime) / 60000);
          updateData.actual_wait_time = waitTimeMinutes;
        }
        break;
      case 'cancelled':
        updateData.cancelled_at = now;
        updateData.cancellation_reason = reason;
        break;
    }

    const { data, error } = await supabase
      .from('tokens')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        patient:patient_id(first_name, last_name, phone),
        department:department_id(name, code),
        staff:staff_id(name)
      `)
      .single();

    if (error) throw error;

    await supabase
      .from('queue_log')
      .insert({
        token_id: id,
        department_id: data.department_id,
        action: status,
        previous_status: currentToken.status,
        new_status: status,
        wait_time_before_action: status === 'completed' ? data.actual_wait_time : null,
        performed_by: req.user.id,
        timestamp: new Date().toISOString()
      });

    res.json(data);
  } catch (error) {
    console.error('Error updating token status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ GET DEPARTMENTS ============
app.get('/api/departments', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('departments')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching departments:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ GET STAFF ============
app.get('/api/staff', authenticateToken, async (req, res) => {
  try {
    const { role } = req.query;
    let query = supabase
      .from('staff')
      .select('id, name, email, role, specialty, department_id, is_active')
      .eq('is_active', true);

    if (role) query = query.eq('role', role);

    const { data, error } = await query.order('name', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ ANALYTICS DASHBOARD ============
app.get('/api/analytics/dashboard', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const [patientsToday, activeTokens, waitingTokens, completedToday, totalPatients, totalTokens] = await Promise.all([
      supabase.from('patients').select('id', { count: 'exact', head: true }).gte('created_at', today),
      supabase.from('tokens').select('id', { count: 'exact', head: true }).in('status', ['waiting', 'in-progress']),
      supabase.from('tokens').select('estimated_wait_time').eq('status', 'waiting'),
      supabase.from('tokens').select('id', { count: 'exact', head: true }).eq('status', 'completed').gte('completed_at', today),
      supabase.from('patients').select('id', { count: 'exact', head: true }),
      supabase.from('tokens').select('id', { count: 'exact', head: true })
    ]);

    let avgWaitTime = 0;
    if (waitingTokens.data && waitingTokens.data.length > 0) {
      const totalWait = waitingTokens.data.reduce((sum, t) => sum + (t.estimated_wait_time || 15), 0);
      avgWaitTime = Math.round(totalWait / waitingTokens.data.length);
    }

    const { data: departments } = await supabase
      .from('departments')
      .select('id, name, code');

    const departmentStats = await Promise.all(departments.map(async (dept) => {
      const { data: tokens } = await supabase
        .from('tokens')
        .select('status')
        .eq('department_id', dept.id);
      
      const waiting = tokens?.filter(t => t.status === 'waiting').length || 0;
      const inProgress = tokens?.filter(t => t.status === 'in-progress').length || 0;
      const completed = tokens?.filter(t => t.status === 'completed').length || 0;
      const total = tokens?.length || 0;
      
      return {
        ...dept,
        waiting,
        in_progress: inProgress,
        completed,
        total,
        efficiency: total > 0 ? Math.round((completed / total) * 100) : 0
      };
    }));

    const hourlyData = [];
    for (let hour = 8; hour <= 20; hour++) {
      const hourStart = `${today} ${String(hour).padStart(2, '0')}:00:00`;
      const hourEnd = `${today} ${String(hour).padStart(2, '0')}:59:59`;
      
      const { count } = await supabase
        .from('tokens')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', hourStart)
        .lte('created_at', hourEnd);
      
      hourlyData.push(count || 0);
    }

    res.json({
      patients_today: patientsToday.count || 0,
      active_tokens: activeTokens.count || 0,
      avg_wait_time: avgWaitTime,
      completed_today: completedToday.count || 0,
      total_patients: totalPatients.count || 0,
      total_tokens: totalTokens.count || 0,
      departments: departmentStats,
      hourly_data: hourlyData,
      hourly_labels: ['8AM', '9AM', '10AM', '11AM', '12PM', '1PM', '2PM', '3PM', '4PM', '5PM', '6PM', '7PM', '8PM']
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ TOKEN ANALYTICS ============
app.get('/api/analytics/tokens', authenticateToken, async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    
    let startDate;
    const today = new Date();
    
    switch (period) {
      case 'week':
        startDate = new Date(today.setDate(today.getDate() - 7));
        break;
      case 'month':
        startDate = new Date(today.setMonth(today.getMonth() - 1));
        break;
      case 'year':
        startDate = new Date(today.setFullYear(today.getFullYear() - 1));
        break;
      default:
        startDate = new Date(today.setDate(today.getDate() - 7));
    }

    const { data, error } = await supabase
      .from('tokens')
      .select('status, created_at, completed_at, actual_wait_time')
      .gte('created_at', startDate.toISOString());

    if (error) throw error;

    const total = data.length;
    const completed = data.filter(t => t.status === 'completed').length;
    const cancelled = data.filter(t => t.status === 'cancelled').length;
    const waiting = data.filter(t => t.status === 'waiting').length;
    const inProgress = data.filter(t => t.status === 'in-progress').length;
    
    const avgWaitTime = data
      .filter(t => t.actual_wait_time)
      .reduce((sum, t) => sum + t.actual_wait_time, 0) / (data.filter(t => t.actual_wait_time).length || 1);
    
    const byDate = {};
    data.forEach(token => {
      const date = token.created_at.split('T')[0];
      if (!byDate[date]) {
        byDate[date] = { total: 0, completed: 0, cancelled: 0 };
      }
      byDate[date].total++;
      if (token.status === 'completed') byDate[date].completed++;
      if (token.status === 'cancelled') byDate[date].cancelled++;
    });

    res.json({
      total,
      completed,
      cancelled,
      waiting,
      in_progress: inProgress,
      avg_wait_time: Math.round(avgWaitTime),
      by_date: byDate,
      completion_rate: total > 0 ? Math.round((completed / total) * 100) : 0
    });
  } catch (error) {
    console.error('Error fetching token analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ APPOINTMENT ROUTES ============
app.post('/api/appointments', authenticateToken, async (req, res) => {
  try {
    const { patient_id, department_id, staff_id, token_id, appointment_date, appointment_time, duration, notes } = req.body;

    if (!patient_id || !appointment_date || !appointment_time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabase
      .from('appointments')
      .insert({
        patient_id,
        department_id,
        staff_id,
        token_id,
        appointment_date,
        appointment_time,
        duration: duration || 15,
        status: 'scheduled',
        notes,
        created_by: req.user.id,
        created_at: new Date().toISOString()
      })
      .select(`
        *,
        patient:patient_id(first_name, last_name, phone),
        department:department_id(name, code),
        staff:staff_id(name)
      `)
      .single();

    if (error) throw error;

    res.json({ message: 'Appointment created successfully', appointment: data });
  } catch (error) {
    console.error('Error creating appointment:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/appointments/patient/:patientId', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    
    const { data, error } = await supabase
      .from('appointments')
      .select(`
        *,
        department:department_id(name, code),
        staff:staff_id(name)
      `)
      .eq('patient_id', patientId)
      .order('appointment_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ TEST DATABASE ROUTE ============
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('staff').select('*');
    
    if (error) {
      res.json({ error: error.message });
    } else {
      res.json({ success: true, count: data?.length, data });
    }
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('\n=================================');
  console.log('🚀 pehia Queue Management API');
  console.log('=================================');
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔌 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log('=================================\n');
});