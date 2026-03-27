const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabaseClient');

const router = express.Router();

// Staff Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find staff member
    const { data: staff, error } = await supabaseAdmin
      .from('staff')
      .select('id, email, name, role, password_hash, department_id')
      .eq('email', email)
      .single();

    if (error || !staff) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, staff.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await supabaseAdmin
      .from('staff')
      .update({ last_login: new Date().toISOString() })
      .eq('id', staff.id);

    // Generate JWT
    const token = jwt.sign(
      { userId: staff.id, email: staff.email, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Get department info if assigned
    let department = null;
    if (staff.department_id) {
      const { data: dept } = await supabaseAdmin
        .from('departments')
        .select('name, code')
        .eq('id', staff.department_id)
        .single();
      department = dept;
    }

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
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify Token
router.post('/verify', authenticateToken, async (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Change Password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const userId = req.user.id;

    // Get current password hash
    const { data: staff, error } = await supabaseAdmin
      .from('staff')
      .select('password_hash')
      .eq('id', userId)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Error fetching user' });
    }

    // Verify old password
    const isValid = await bcrypt.compare(oldPassword, staff.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    const { error: updateError } = await supabaseAdmin
      .from('staff')
      .update({ password_hash: hashedPassword })
      .eq('id', userId);

    if (updateError) {
      return res.status(500).json({ error: 'Error updating password' });
    }

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;