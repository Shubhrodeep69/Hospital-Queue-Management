const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabaseClient');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify staff exists in database
    const { data: staff, error } = await supabaseAdmin
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
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const authorizeAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const authorizeDoctor = (req, res, next) => {
  if (!['admin', 'doctor'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Doctor access required' });
  }
  next();
};

module.exports = { authenticateToken, authorizeAdmin, authorizeDoctor };