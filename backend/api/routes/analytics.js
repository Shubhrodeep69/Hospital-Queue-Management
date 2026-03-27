const express = require('express');
const { authenticateToken, authorizeAdmin } = require('../middleware/auth');
const { supabaseAdmin } = require('../utils/supabaseClient');

const router = express.Router();

// Get dashboard stats
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get today's stats
    const [patientsToday, activeTokens, avgWaitTime, completedToday, departmentStats] = await Promise.all([
      supabaseAdmin
        .from('patients')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', today),
      
      supabaseAdmin
        .from('tokens')
        .select('id', { count: 'exact', head: true })
        .in('status', ['waiting', 'called', 'in-progress']),
      
      supabaseAdmin
        .from('tokens')
        .select('estimated_wait_time')
        .eq('status', 'waiting'),
      
      supabaseAdmin
        .from('tokens')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'completed')
        .gte('completed_at', today),
      
      supabaseAdmin
        .from('departments')
        .select(`
          id,
          name,
          code,
          tokens:tokens(count),
          waiting:tokens!inner(count)
        `)
        .eq('tokens.status', 'completed')
    ]);

    // Calculate average wait time
    let avgWait = 0;
    if (avgWaitTime.data && avgWaitTime.data.length > 0) {
      const total = avgWaitTime.data.reduce((sum, t) => sum + t.estimated_wait_time, 0);
      avgWait = Math.round(total / avgWaitTime.data.length);
    }

    res.json({
      patients_today: patientsToday.count || 0,
      active_tokens: activeTokens.count || 0,
      avg_wait_time: avgWait,
      completed_today: completedToday.count || 0,
      departments: departmentStats.data || []
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get department performance
router.get('/departments', authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    let query = supabaseAdmin
      .from('departments')
      .select(`
        id,
        name,
        code,
        tokens:tokens(
          id,
          status,
          created_at,
          completed_at,
          estimated_wait_time,
          actual_wait_time
        )
      `);

    if (start_date && end_date) {
      query = query.gte('tokens.created_at', start_date).lte('tokens.created_at', end_date);
    }

    const { data, error } = await query;

    if (error) throw error;

    const performance = data.map(dept => {
      const tokens = dept.tokens || [];
      const total = tokens.length;
      const completed = tokens.filter(t => t.status === 'completed').length;
      const cancelled = tokens.filter(t => t.status === 'cancelled').length;
      const avgWait = tokens
        .filter(t => t.actual_wait_time)
        .reduce((sum, t) => sum + t.actual_wait_time, 0) / (tokens.filter(t => t.actual_wait_time).length || 1);
      
      return {
        ...dept,
        total_patients: total,
        completed,
        cancelled,
        efficiency: total > 0 ? Math.round((completed / total) * 100) : 0,
        avg_wait_time: Math.round(avgWait)
      };
    });

    res.json(performance);
  } catch (error) {
    console.error('Error fetching department performance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get hourly patient flow
router.get('/hourly-flow', authenticateToken, async (req, res) => {
  try {
    const { date = new Date().toISOString().split('T')[0] } = req.query;
    
    const { data, error } = await supabaseAdmin
      .from('tokens')
      .select('created_at')
      .gte('created_at', `${date} 00:00:00`)
      .lte('created_at', `${date} 23:59:59`);

    if (error) throw error;

    // Group by hour
    const hourlyData = Array(12).fill(0); // 8AM to 8PM
    data.forEach(token => {
      const hour = new Date(token.created_at).getHours();
      if (hour >= 8 && hour <= 20) {
        hourlyData[hour - 8]++;
      }
    });

    const hours = ['8AM', '9AM', '10AM', '11AM', '12PM', '1PM', '2PM', '3PM', '4PM', '5PM', '6PM', '7PM', '8PM'];
    
    res.json({
      labels: hours,
      data: hourlyData
    });
  } catch (error) {
    console.error('Error fetching hourly flow:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get token analytics
router.get('/tokens', authenticateToken, async (req, res) => {
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

    const { data, error } = await supabaseAdmin
      .from('tokens')
      .select('status, created_at, completed_at, actual_wait_time')
      .gte('created_at', startDate.toISOString());

    if (error) throw error;

    const total = data.length;
    const completed = data.filter(t => t.status === 'completed').length;
    const cancelled = data.filter(t => t.status === 'cancelled').length;
    const avgWaitTime = data
      .filter(t => t.actual_wait_time)
      .reduce((sum, t) => sum + t.actual_wait_time, 0) / (data.filter(t => t.actual_wait_time).length || 1);
    
    // Group by date
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
      avg_wait_time: Math.round(avgWaitTime),
      by_date: byDate,
      completion_rate: total > 0 ? Math.round((completed / total) * 100) : 0
    });
  } catch (error) {
    console.error('Error fetching token analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;