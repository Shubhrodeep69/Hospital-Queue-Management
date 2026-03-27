const { supabaseAdmin } = require('./supabaseClient');

// Calculate priority score
const calculatePriorityScore = (priority) => {
  const scores = {
    emergency: 100,
    vip: 80,
    senior: 60,
    normal: 40,
    low: 20
  };
  return scores[priority] || 40;
};

// Generate next token number for department
const generateNextTokenNumber = async (departmentId) => {
  const today = new Date().toISOString().split('T')[0];
  
  // Get department code
  const { data: department } = await supabaseAdmin
    .from('departments')
    .select('code')
    .eq('id', departmentId)
    .single();

  // Get today's max token
  const { data: lastToken } = await supabaseAdmin
    .from('tokens')
    .select('token_number')
    .eq('department_id', departmentId)
    .gte('created_at', today)
    .order('token_number', { ascending: false })
    .limit(1);

  let nextNumber = 1;
  if (lastToken && lastToken.length > 0) {
    const match = lastToken[0].token_number.match(/\d+$/);
    if (match) {
      nextNumber = parseInt(match[0]) + 1;
    }
  }

  return `${department.code}-${String(nextNumber).padStart(4, '0')}`;
};

// Calculate estimated wait time
const calculateWaitTime = async (departmentId, priority = 'normal') => {
  // Get waiting tokens count
  const { data: waitingTokens } = await supabaseAdmin
    .from('tokens')
    .select('priority')
    .eq('department_id', departmentId)
    .eq('status', 'waiting');

  if (!waitingTokens || waitingTokens.length === 0) {
    // Get department average wait time
    const { data: department } = await supabaseAdmin
      .from('departments')
      .select('avg_wait_time')
      .eq('id', departmentId)
      .single();
    return department?.avg_wait_time || 15;
  }

  // Calculate weighted wait time based on priority
  let totalWeight = 0;
  let weightedSum = 0;
  const baseWaitTime = 15; // minutes per patient

  waitingTokens.forEach(token => {
    const weight = calculatePriorityScore(token.priority);
    totalWeight += weight;
    weightedSum += weight * baseWaitTime;
  });

  const currentPriorityWeight = calculatePriorityScore(priority);
  const averageWait = weightedSum / totalWeight;
  
  // If current patient has higher priority, reduce wait time
  if (currentPriorityWeight > totalWeight / waitingTokens.length) {
    return Math.max(5, averageWait * 0.7);
  }
  
  return Math.min(60, averageWait);
};

// Generate new token
const generateToken = async (data) => {
  const {
    patient_id,
    department_id,
    staff_id,
    priority = 'normal',
    notes
  } = data;

  // Get department info
  const { data: department } = await supabaseAdmin
    .from('departments')
    .select('*')
    .eq('id', department_id)
    .single();

  if (!department) {
    throw new Error('Department not found');
  }

  // Generate token number
  const tokenNumber = await generateNextTokenNumber(department_id);

  // Calculate estimated wait time
  const estimatedWaitTime = await calculateWaitTime(department_id, priority);

  // Calculate priority score
  const priorityScore = calculatePriorityScore(priority);

  // Assign counter number (simple round-robin)
  const counterNumber = (await getNextCounterNumber(department_id));

  // Create token
  const { data: token, error } = await supabaseAdmin
    .from('tokens')
    .insert({
      token_number: tokenNumber,
      patient_id,
      department_id,
      staff_id,
      priority,
      priority_score: priorityScore,
      counter_number: counterNumber,
      estimated_wait_time: estimatedWaitTime,
      status: 'waiting'
    })
    .select()
    .single();

  if (error) throw error;

  // Update department current token counter
  await supabaseAdmin
    .from('departments')
    .update({ current_token_number: tokenNumber })
    .eq('id', department_id);

  return token;
};

// Get next counter number for department
const getNextCounterNumber = async (departmentId) => {
  const { data: counters } = await supabaseAdmin
    .from('tokens')
    .select('counter_number')
    .eq('department_id', departmentId)
    .eq('status', 'in-progress')
    .order('counter_number', { ascending: false })
    .limit(1);

  if (counters && counters.length > 0) {
    return counters[0].counter_number;
  }
  return Math.floor(Math.random() * 5) + 1;
};

// Update token status with proper logging
const updateTokenStatus = async (tokenId, newStatus, userId, reason = null) => {
  const { data: token, error: fetchError } = await supabaseAdmin
    .from('tokens')
    .select('*')
    .eq('id', tokenId)
    .single();

  if (fetchError) throw fetchError;

  const oldStatus = token.status;
  const updateData = { status: newStatus };

  // Add timestamps based on status
  switch (newStatus) {
    case 'called':
      updateData.called_at = new Date().toISOString();
      break;
    case 'in-progress':
      updateData.started_at = new Date().toISOString();
      break;
    case 'completed':
      updateData.completed_at = new Date().toISOString();
      if (token.started_at) {
        const actualWaitTime = Math.round((new Date(updateData.completed_at) - new Date(token.started_at)) / 60000);
        updateData.actual_wait_time = actualWaitTime;
      }
      break;
    case 'cancelled':
      updateData.cancelled_at = new Date().toISOString();
      updateData.cancellation_reason = reason;
      break;
  }

  const { data: updatedToken, error: updateError } = await supabaseAdmin
    .from('tokens')
    .update(updateData)
    .eq('id', tokenId)
    .select()
    .single();

  if (updateError) throw updateError;

  // Log to queue_log
  await supabaseAdmin
    .from('queue_log')
    .insert({
      token_id: tokenId,
      department_id: token.department_id,
      action: newStatus,
      previous_status: oldStatus,
      new_status: newStatus,
      wait_time_before_action: token.estimated_wait_time,
      performed_by: userId
    });

  return updatedToken;
};

// Get department queue
const getDepartmentQueue = async (departmentId) => {
  const { data: tokens, error } = await supabaseAdmin
    .from('tokens')
    .select(`
      *,
      patient:patient_id(first_name, last_name, phone),
      staff:staff_id(name)
    `)
    .eq('department_id', departmentId)
    .in('status', ['waiting', 'called', 'in-progress'])
    .order('priority_score', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) throw error;

  // Calculate positions
  let position = 1;
  const queueWithPositions = tokens.map(token => {
    const queueItem = {
      ...token,
      position: token.status === 'waiting' ? position++ : null
    };
    return queueItem;
  });

  return queueWithPositions;
};

// Get next token to call
const getNextTokenToCall = async (departmentId) => {
  const { data: token, error } = await supabaseAdmin
    .from('tokens')
    .select('*')
    .eq('department_id', departmentId)
    .eq('status', 'waiting')
    .order('priority_score', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return token;
};

module.exports = {
  generateToken,
  updateTokenStatus,
  getDepartmentQueue,
  getNextTokenToCall,
  calculateWaitTime
};