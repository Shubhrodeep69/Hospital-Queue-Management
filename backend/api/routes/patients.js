const express = require('express');
const { authenticateToken, authorizeDoctor } = require('../middleware/auth');
const { supabaseAdmin } = require('../utils/supabaseClient');
const { generateToken } = require('../utils/queueLogic');

const router = express.Router();

// Get all patients (with filters)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { search, department, date } = req.query;
    let query = supabaseAdmin.from('patients').select('*, department:department_id(name)');

    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    if (date) {
      query = query.eq('created_at::date', date);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching patients:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single patient
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('patients')
      .select('*, department:department_id(*)')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Patient not found' });

    // Get patient's tokens
    const { data: tokens } = await supabaseAdmin
      .from('tokens')
      .select('*')
      .eq('patient_id', req.params.id)
      .order('created_at', { ascending: false });

    res.json({ ...data, tokens });
  } catch (error) {
    console.error('Error fetching patient:', error);
    res.status(500).json({ error: error.message });
  }
});

// Register new patient and generate token
router.post('/register', authenticateToken, async (req, res) => {
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

    // Validate required fields
    if (!first_name || !last_name || !date_of_birth || !phone || !department_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if patient already exists
    const { data: existingPatient } = await supabaseAdmin
      .from('patients')
      .select('id')
      .eq('phone', phone)
      .single();

    let patientId;

    if (existingPatient) {
      patientId = existingPatient.id;
    } else {
      // Create new patient
      const { data: patient, error: patientError } = await supabaseAdmin
        .from('patients')
        .insert({
          first_name,
          last_name,
          date_of_birth,
          phone,
          email,
          created_by: req.user.id
        })
        .select()
        .single();

      if (patientError) throw patientError;
      patientId = patient.id;
    }

    // Generate token
    const tokenData = await generateToken({
      patient_id: patientId,
      department_id,
      staff_id: doctor_id,
      priority,
      notes
    });

    // Log queue creation
    await supabaseAdmin
      .from('queue_log')
      .insert({
        token_id: tokenData.id,
        department_id,
        action: 'created',
        previous_status: null,
        new_status: 'waiting',
        performed_by: req.user.id
      });

    // Create notification
    await createNotification({
      patient_id: patientId,
      token_id: tokenData.id,
      type: 'sms',
      title: 'Token Generated',
      message: `Your token ${tokenData.token_number} has been generated. Estimated wait time: ${tokenData.estimated_wait_time} minutes.`
    });

    res.status(201).json({
      message: 'Patient registered successfully',
      patient: { id: patientId, name: `${first_name} ${last_name}` },
      token: tokenData
    });
  } catch (error) {
    console.error('Error registering patient:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update patient
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('patients')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error updating patient:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;