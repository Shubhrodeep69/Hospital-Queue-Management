-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. DEPARTMENTS TABLE
-- ============================================
CREATE TABLE departments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    code VARCHAR(20) NOT NULL UNIQUE,
    description TEXT,
    current_token_number INT DEFAULT 0,
    avg_wait_time INT DEFAULT 15,
    is_active BOOLEAN DEFAULT true,
    priority_level INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 2. STAFF TABLE (Authentication)
-- ============================================
CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    role VARCHAR(50) DEFAULT 'staff', -- admin, doctor, receptionist
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    specialty VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 3. PATIENTS TABLE
-- ============================================
CREATE TABLE patients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE NOT NULL,
    age INT,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    address TEXT,
    emergency_contact VARCHAR(20),
    medical_history TEXT,
    allergies TEXT,
    blood_group VARCHAR(5),
    created_by UUID REFERENCES staff(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 4. TOKENS TABLE (Queue System)
-- ============================================
CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_number VARCHAR(50) NOT NULL,
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    department_id UUID REFERENCES departments(id),
    staff_id UUID REFERENCES staff(id),
    status VARCHAR(20) DEFAULT 'waiting', -- waiting, called, in-progress, completed, cancelled, no-show
    priority VARCHAR(20) DEFAULT 'normal', -- normal, emergency, senior, vip
    priority_score INT DEFAULT 0,
    counter_number INT,
    estimated_wait_time INT,
    actual_wait_time INT,
    called_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    cancellation_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    INDEX idx_tokens_status (status),
    INDEX idx_tokens_department (department_id),
    INDEX idx_tokens_created (created_at),
    INDEX idx_tokens_priority (priority_score DESC)
);

-- ============================================
-- 5. APPOINTMENTS TABLE
-- ============================================
CREATE TABLE appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    department_id UUID REFERENCES departments(id),
    staff_id UUID REFERENCES staff(id),
    token_id UUID REFERENCES tokens(id),
    appointment_date DATE NOT NULL,
    appointment_time TIME NOT NULL,
    duration INT DEFAULT 15, -- minutes
    status VARCHAR(20) DEFAULT 'scheduled', -- scheduled, confirmed, cancelled, completed, no-show
    notes TEXT,
    created_by UUID REFERENCES staff(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    INDEX idx_appointments_date (appointment_date),
    INDEX idx_appointments_status (status)
);

-- ============================================
-- 6. QUEUE_LOG TABLE (Analytics)
-- ============================================
CREATE TABLE queue_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id UUID REFERENCES tokens(id),
    department_id UUID REFERENCES departments(id),
    action VARCHAR(50), -- created, called, started, completed, cancelled, no-show
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    wait_time_before_action INT,
    performed_by UUID REFERENCES staff(id),
    timestamp TIMESTAMP DEFAULT NOW(),
    
    INDEX idx_queue_log_token (token_id),
    INDEX idx_queue_log_timestamp (timestamp),
    INDEX idx_queue_log_department (department_id)
);

-- ============================================
-- 7. NOTIFICATIONS TABLE
-- ============================================
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID REFERENCES patients(id),
    token_id UUID REFERENCES tokens(id),
    type VARCHAR(20), -- sms, push, email
    title VARCHAR(255),
    message TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- pending, sent, failed, delivered
    sent_at TIMESTAMP,
    delivery_status VARCHAR(50),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    
    INDEX idx_notifications_status (status),
    INDEX idx_notifications_patient (patient_id)
);

-- ============================================
-- 8. PAYMENTS TABLE
-- ============================================
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID REFERENCES patients(id),
    token_id UUID REFERENCES tokens(id),
    appointment_id UUID REFERENCES appointments(id),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'INR',
    payment_method VARCHAR(50), -- cash, card, upi, online
    payment_status VARCHAR(20) DEFAULT 'pending', -- pending, completed, failed, refunded
    transaction_id VARCHAR(100),
    payment_date TIMESTAMP,
    receipt_number VARCHAR(100),
    notes TEXT,
    created_by UUID REFERENCES staff(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    INDEX idx_payments_status (payment_status),
    INDEX idx_payments_patient (patient_id)
);

-- ============================================
-- 9. ANALYTICS_DAILY TABLE (Pre-aggregated data)
-- ============================================
CREATE TABLE analytics_daily (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    date DATE NOT NULL,
    department_id UUID REFERENCES departments(id),
    total_patients INT DEFAULT 0,
    total_tokens INT DEFAULT 0,
    completed_tokens INT DEFAULT 0,
    cancelled_tokens INT DEFAULT 0,
    avg_wait_time DECIMAL(5,2),
    avg_service_time DECIMAL(5,2),
    peak_hour INT,
    created_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(date, department_id)
);

-- ============================================
-- CREATE INDEXES FOR PERFORMANCE
-- ============================================
CREATE INDEX idx_patients_phone ON patients(phone);
CREATE INDEX idx_patients_name ON patients(first_name, last_name);
CREATE INDEX idx_tokens_department_status ON tokens(department_id, status);
CREATE INDEX idx_queue_log_department_date ON queue_log(department_id, date(timestamp));

-- ============================================
-- CREATE TRIGGER FOR UPDATED_AT
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_staff_updated_at BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_patients_updated_at BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_appointments_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================
-- Enable RLS on all tables
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Policies for authenticated users
CREATE POLICY "Allow authenticated users to read departments" 
    ON departments FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow staff to manage patients" 
    ON patients FOR ALL TO authenticated 
    USING (auth.role() = 'authenticated');

CREATE POLICY "Allow staff to manage tokens" 
    ON tokens FOR ALL TO authenticated 
    USING (auth.role() = 'authenticated');

-- ============================================
-- INSERT SAMPLE DATA
-- ============================================
INSERT INTO departments (name, code, description, avg_wait_time, priority_level) VALUES
('Emergency', 'EMG', 'Emergency Department - 24/7 Critical Care', 15, 1),
('Outpatient', 'OPD', 'General Outpatient Department', 30, 2),
('Cardiology', 'CAR', 'Heart Care Center', 45, 2),
('Pediatrics', 'PED', 'Children''s Hospital', 25, 2),
('Orthopedics', 'ORT', 'Bone & Joint Center', 35, 2);

-- Insert sample staff (password: staff123 hashed)
INSERT INTO staff (email, password_hash, name, role, department_id, specialty) VALUES
('admin@pehia.com', '$2a$10$YourHashedPasswordHere', 'Admin User', 'admin', NULL, 'System Administrator'),
('dr.yates@pehia.com', '$2a$10$YourHashedPasswordHere', 'Dr. Charlie Yates', 'doctor', (SELECT id FROM departments WHERE code='EMG'), 'Emergency Medicine'),
('dr.rojas@pehia.com', '$2a$10$YourHashedPasswordHere', 'Dr. Emanuel Rojas', 'doctor', (SELECT id FROM departments WHERE code='CAR'), 'Cardiology'),
('dr.letendre@pehia.com', '$2a$10$YourHashedPasswordHere', 'Dr. Kyle Letendre', 'doctor', (SELECT id FROM departments WHERE code='PED'), 'Pediatrics'),
('dr.erden@pehia.com', '$2a$10$YourHashedPasswordHere', 'Dr. Jeroen Eerden', 'doctor', (SELECT id FROM departments WHERE code='OPD'), 'General Medicine'),
('dr.stolz@pehia.com', '$2a$10$YourHashedPasswordHere', 'Dr. Dmitry Stolz', 'doctor', (SELECT id FROM departments WHERE code='EMG'), 'Emergency Medicine'),
('dr.johnson@pehia.com', '$2a$10$YourHashedPasswordHere', 'Dr. Sarah Johnson', 'doctor', (SELECT id FROM departments WHERE code='ORT'), 'Orthopedic Surgery');

-- Function to calculate age
CREATE OR REPLACE FUNCTION calculate_age(birth_date DATE)
RETURNS INT AS $$
BEGIN
    RETURN EXTRACT(YEAR FROM age(CURRENT_DATE, birth_date));
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-calculate age
CREATE OR REPLACE FUNCTION update_patient_age()
RETURNS TRIGGER AS $$
BEGIN
    NEW.age := calculate_age(NEW.date_of_birth);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_patient_age_trigger 
    BEFORE INSERT OR UPDATE OF date_of_birth ON patients 
    FOR EACH ROW EXECUTE FUNCTION update_patient_age();