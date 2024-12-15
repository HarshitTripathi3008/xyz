const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const validator = require('validator');
require('dotenv').config();

const app = express();

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 8081,
    DB_CONFIG: {
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'railway_reservation_system'
    },
    SALT_ROUNDS: 10
};

// Middleware
app.use(cors());
app.use(express.json());

// Middleware for sanitizing inputs
app.use((req, res, next) => {
    if (req.body) {
        Object.keys(req.body).forEach((key) => {
            if (typeof req.body[key] === 'string') {
                req.body[key] = req.body[key].trim();
            }
        });
    }
    next();
});

// Database Connection Pool
const pool = mysql.createPool({
    ...CONFIG.DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Validation Utility
const ValidationUtils = {
    validateName(name) {
        if (!name || typeof name !== 'string' || name.length < 2 || name.length > 50) {
            return { isValid: false, message: "Name must be between 2-50 characters." };
        }
        return { isValid: true };
    },

    validateEmail(email) {
        if (!email || !validator.isEmail(email)) {
            return { isValid: false, message: "Invalid email address." };
        }
        return { isValid: true };
    },

    validatePassword(password) {
        const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
        if (!password || password.length < 8 || !strongPasswordRegex.test(password)) {
            return {
                isValid: false,
                message: "Password must be at least 8 characters, include uppercase, lowercase, number, and special character."
            };
        }
        return { isValid: true };
    }
};

// Authentication Service
const AuthService = {
    async checkUserExists(email) {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        return users.length > 0;
    },

    async createUser(name, email, password) {
        const hashedPassword = await bcrypt.hash(password, CONFIG.SALT_ROUNDS);
        const createdAt = new Date().toISOString();  // To set current timestamp for `last_login`

        const [result] = await pool.execute(
            'INSERT INTO users (name, email, password, status, last_login) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, 'active', createdAt]
        );
        return result.insertId;
    },

    async updateLastLogin(userId) {
        const currentTime = new Date().toISOString();
        await pool.execute('UPDATE users SET last_login = ? WHERE user_id = ?', [currentTime, userId]);
    }
};

// Train Routes
const TrainRoutes = {
    // Search for trains based on departure and arrival stations
    async searchTrains(req, res) {
        try {
            const { departure_station, arrival_station } = req.query;

            // Validate the query parameters
            if (!departure_station || !arrival_station) {
                return res.status(400).json({ success: false, message: 'Both departure and arrival stations are required.' });
            }

            const [trains] = await pool.execute(
                'SELECT * FROM trains WHERE departure_station = ? AND arrival_station = ?',
                [departure_station, arrival_station]
            );

            if (trains.length > 0) {
                // Add available_tickets to each train (assuming there is a field in the `trains` table for available seats)
                trains.forEach(train => {
                    train.available_tickets = train.seats_available; // Add available_tickets from seats_available
                });

                res.json({ success: true, trains });
            } else {
                res.json({ success: false, message: 'No trains found.' });
            }
        } catch (error) {
            console.error('Error in search-trains route:', error);
            res.status(500).json({ success: false, message: 'Internal server error.' });
        }
    },

    // Add a new train
    async addTrain(req, res) {
        try {
            const { train_name, departure_station, arrival_station, departure_time, arrival_time } = req.body;

            const [result] = await pool.execute(
                'INSERT INTO trains (train_name, departure_station, arrival_station, departure_time, arrival_time) VALUES (?, ?, ?, ?, ?)',
                [train_name, departure_station, arrival_station, departure_time, arrival_time]
            );

            res.status(201).json({
                success: true,
                message: 'Train added successfully.',
                train_id: result.insertId
            });
        } catch (error) {
            console.error('Error in add-train route:', error);
            res.status(500).json({ success: false, message: 'Internal server error.' });
        }
    }
};

// Ticket Booking Routes
const BookingRoutes = {
    // Book a ticket
    async bookTicket(req, res) {
        const { train_id, passenger_name, contact_info, seats_to_book } = req.body;

        if (!train_id || !passenger_name || !contact_info || !seats_to_book) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        try {
            const [train] = await pool.execute('SELECT * FROM trains WHERE train_id = ?', [train_id]);
            if (train.length === 0) {
                return res.status(404).json({ success: false, message: 'Train not found.' });
            }

            if (train[0].seats_available < seats_to_book) {
                return res.status(400).json({ success: false, message: 'Not enough seats available.' });
            }

            // Create the booking
            const [result] = await pool.execute(
                'INSERT INTO bookings (train_id, passenger_name, contact_info, status, created_at) VALUES (?, ?, ?, ?, ?)',
                [train_id, passenger_name, contact_info, 'Booked', new Date().toISOString()]
            );

            // Update the available seats
            await pool.execute('UPDATE trains SET seats_available = seats_available - ? WHERE train_id = ?', [seats_to_book, train_id]);

            res.status(201).json({ success: true, message: 'Booking successful.', booking_id: result.insertId });
        } catch (error) {
            console.error('Error in booking ticket:', error);
            res.status(500).json({ success: false, message: 'Internal server error.' });
        }
    }
};

// Routes for Train
app.get('/search-trains', TrainRoutes.searchTrains); // Search trains
app.post('/add-train', TrainRoutes.addTrain);       // Add train

// Routes for Booking
app.post('/book-ticket', BookingRoutes.bookTicket); // Book ticket

// Signup Route
app.post('/signup', async (req, res) => {
    const { name, email, password } = req.body;

    // Validate input
    const nameValidation = ValidationUtils.validateName(name);
    if (!nameValidation.isValid) {
        return res.status(400).json({ success: false, message: nameValidation.message });
    }

    const emailValidation = ValidationUtils.validateEmail(email);
    if (!emailValidation.isValid) {
        return res.status(400).json({ success: false, message: emailValidation.message });
    }

    const passwordValidation = ValidationUtils.validatePassword(password);
    if (!passwordValidation.isValid) {
        return res.status(400).json({ success: false, message: passwordValidation.message });
    }

    try {
        const userExists = await AuthService.checkUserExists(email);
        if (userExists) {
            return res.status(400).json({ success: false, message: 'User already exists.' });
        }

        await AuthService.createUser(name, email, password);

        res.status(201).json({
            success: true,
            message: 'User created successfully.'
        });
    } catch (error) {
        console.error('Error during signup:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Login Route (removed JWT)
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        const user = users[0];
        const isPasswordMatch = await bcrypt.compare(password, user.password);

        if (!isPasswordMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        // Update last login time
        await AuthService.updateLastLogin(user.user_id);

        res.json({
            success: true,
            message: 'Login successful.'
        });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Server start
app.listen(CONFIG.PORT, () => {
    console.log(`Server is running on port ${CONFIG.PORT}`);
});
