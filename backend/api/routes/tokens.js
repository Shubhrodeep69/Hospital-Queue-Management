const express = require('express');
const { authenticateToken, authorizeDoctor } = require('../middleware/auth');
const { supabaseAdmin } = require('../utils/supabaseClient');
const { updateTokenStatus, getDepartmentQueue, getNextTokenToCall } = require('../utils/queueLogic');

const router = express.Router();

// Get all tokens
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { department, status, date } = req.query;
    let query = supabaseAdmin.from('tokens').select(`
      *,
      patient:patient_id(first_name, last_name, phone),
      department:department_id(name, code),
      staff:staff_id(name)
    `);

    if (department) query = query.eq('department_id', department);
    if (status) query = query.eq('status', status);
    if (date) query = query.gte('created_at', date).lt('created_at', `${date}T23:59:59`);

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get department queue
router.get('/queue/:departmentId', authenticateToken, async (req, res) => {
  try {
    const queue = await getDepartmentQueue(req.params.departmentId);
    const nextToken = await getNextTokenToCall(req.params.departmentId);
    
    res.json({
      queue,
      next_token: nextToken,
      total_waiting: queue.filter(t => t.status === 'waiting').length,
      in_progress: queue.filter(t => t.status === 'in-progress').length
    });
  } catch (error) {
    console.error('Error fetching queue:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get token by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tokens')
      .select(`
        *,
        patient:patient_id(*),
        department:department_id(*),
        staff:staff_id(*)
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Token not found' });

    res.json(data);
  } catch (error) {
    console.error('Error fetching token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Call next token
router.post('/call-next/:departmentId', authenticateToken, authorizeDoctor, async (req, res) => {
  try {
    const nextToken = await getNextTokenToCall(req.params.departmentId);
    
    if (!nextToken) {
      return res.status(404).json({ error: 'No waiting tokens' });
    }

    const updatedToken = await updateTokenStatus(nextToken.id, 'called', req.user.id);
    
    // Create notification for patient
    await createNotification({
      patient_id: updatedToken.patient_id,
      token_id: updatedToken.id,
      type: 'sms',
      title: 'Token Called',
      message: `Your token ${updatedToken.token_number} has been called. Please proceed to counter #${updatedToken.counter_number}.`
    });

    res.json(updatedToken);
  } catch (error) {
    console.error('Error calling token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update token status
router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status, reason } = req.body;
    const updatedToken = await updateTokenStatus(req.params.id, status, req.user.id, reason);
    res.json(updatedToken);
  } catch (error) {
    console.error('Error updating token status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start service for token
router.post('/:id/start', authenticateToken, authorizeDoctor, async (req, res) => {
  try {
    const updatedToken = await updateTokenStatus(req.params.id, 'in-progress', req.user.id);
    res.json(updatedToken);
  } catch (error) {
    console.error('Error starting service:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete service for token
router.post('/:id/complete', authenticateToken, authorizeDoctor, async (req, res) => {
  try {
    const updatedToken = await updateTokenStatus(req.params.id, 'completed', req.user.id);
    
    // Update analytics
    await updateDailyAnalytics(updatedToken.department_id);
    
    res.json(updatedToken);
  } catch (error) {
    console.error('Error completing service:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel token
router.post('/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { reason } = req.body;
    const updatedToken = await updateTokenStatus(req.params.id, 'cancelled', req.user.id, reason);
    res.json(updatedToken);
  } catch (error) {
    console.error('Error cancelling token:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;