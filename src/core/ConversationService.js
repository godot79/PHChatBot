// Services/ConversationService.js
const WhatsAppAPI = require('../APIs/WhatsAppAPI');
const ClinikoAPI = require('../APIs/ClinikoAPI');

class ConversationService {
    constructor(whatsappAPI, clinikoAPI) {
        this.whatsapp = whatsappAPI;
        this.cliniko = clinikoAPI;
        this.userStates = new Map(); // Store conversation states
    }

    // Process incoming WhatsApp message
    async processMessage(messageData) {
        try {
            const { from, text, messageType, messageId } = messageData;
            
            // Mark message as read
            await this.whatsapp.markAsRead(messageId);
            
            // Get or create user state
            let userState = this.userStates.get(from) || {
                step: 'greeting',
                patient: null,
                context: {}
            };

            // Find patient by phone number
            if (!userState.patient) {
                userState.patient = await this.cliniko.findPatientByPhone(from);
            }

            // Process based on message type and current state
            const response = await this.handleConversationFlow(from, text, userState);
            
            // Update user state
            this.userStates.set(from, userState);
            
            return response;
        } catch (error) {
            console.error('Error processing message:', error);
            await this.whatsapp.sendMessage(messageData.from, 
                "I'm sorry, I encountered an error. Please try again or contact our support team.");
            throw error;
        }
    }

    // Handle conversation flow based on user state
    async handleConversationFlow(phoneNumber, message, userState) {
        const lowerMessage = (message || '').toLowerCase().trim();

        switch (userState.step) {
            case 'greeting':
                return await this.handleGreeting(phoneNumber, userState);
            
            case 'main_menu':
                return await this.handleMainMenu(phoneNumber, lowerMessage, userState);
            
            case 'book_appointment':
                return await this.handleBookingFlow(phoneNumber, lowerMessage, userState);
            
            case 'view_appointments':
                return await this.handleViewAppointments(phoneNumber, userState);
            
            case 'cancel_appointment':
                return await this.handleCancelAppointment(phoneNumber, lowerMessage, userState);
            
            case 'patient_registration':
                return await this.handlePatientRegistration(phoneNumber, lowerMessage, userState);
            
            default:
                return await this.handleGreeting(phoneNumber, userState);
        }
    }

    // Handle initial greeting
    async handleGreeting(phoneNumber, userState) {
        if (userState.patient) {
            // Existing patient
            const message = `Hello ${userState.patient.first_name}! 👋 Welcome back to our healthcare assistant.`;
            
            await this.whatsapp.sendMessage(phoneNumber, message);
            return await this.showMainMenu(phoneNumber, userState);
        } else {
            // New patient
            const message = `Hello! 👋 Welcome to our healthcare assistant. 

I don't have your information in our system yet. Would you like to:

1️⃣ Register as a new patient
2️⃣ Speak with our reception team

Please reply with 1 or 2.`;

            userState.step = 'patient_registration';
            return await this.whatsapp.sendMessage(phoneNumber, message);
        }
    }

    // Show main menu
    async showMainMenu(phoneNumber, userState) {
        userState.step = 'main_menu';
        
        const buttons = [
            { id: 'book', title: '📅 Book Appointment' },
            { id: 'view', title: '👁️ View Appointments' },
            { id: 'cancel', title: '❌ Cancel Appointment' }
        ];

        return await this.whatsapp.sendButtons(
            phoneNumber,
            'What would you like to do today?',
            buttons,
            {
                header: '🏥 Healthcare Assistant',
                footer: 'Select an option or type your request'
            }
        );
    }

    // Handle main menu selection
    async handleMainMenu(phoneNumber, message, userState) {
        if (message.includes('book') || message === '1') {
            userState.step = 'book_appointment';
            userState.context = { bookingStep: 'select_practitioner' };
            return await this.startBookingFlow(phoneNumber, userState);
        } else if (message.includes('view') || message === '2') {
            userState.step = 'view_appointments';
            return await this.handleViewAppointments(phoneNumber, userState);
        } else if (message.includes('cancel') || message === '3') {
            userState.step = 'cancel_appointment';
            return await this.startCancelFlow(phoneNumber, userState);
        } else {
            return await this.whatsapp.sendMessage(phoneNumber, 
                "I didn't understand that. Please select one of the options or type 'menu' to see the main menu again.");
        }
    }

    // Start appointment booking flow
    async startBookingFlow(phoneNumber, userState) {
        try {
            const practitioners = await this.cliniko.getPractitioners({ per_page: 10 });
            
            if (!practitioners.practitioners || practitioners.practitioners.length === 0) {
                return await this.whatsapp.sendMessage(phoneNumber, 
                    "Sorry, no practitioners are available at the moment. Please try again later.");
            }

            const sections = [{
                title: 'Available Practitioners',
                rows: practitioners.practitioners.map(practitioner => ({
                    id: `prac_${practitioner.id}`,
                    title: practitioner.name,
                    description: `${practitioner.title || 'Doctor'}`
                }))
            }];

            userState.context.practitioners = practitioners.practitioners;
            
            return await this.whatsapp.sendList(
                phoneNumber,
                'Please select a practitioner for your appointment:',
                'Select Practitioner',
                sections,
                { header: '👨‍⚕️ Choose Your Doctor' }
            );
        } catch (error) {
            console.error('Error starting booking flow:', error);
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Sorry, I couldn't load the practitioners. Please try again later.");
        }
    }

    // Handle appointment booking flow
    async handleBookingFlow(phoneNumber, message, userState) {
        const { bookingStep } = userState.context;

        switch (bookingStep) {
            case 'select_practitioner':
                if (message.startsWith('prac_')) {
                    const practitionerId = message.replace('prac_', '');
                    userState.context.selectedPractitioner = practitionerId;
                    userState.context.bookingStep = 'select_appointment_type';
                    return await this.showAppointmentTypes(phoneNumber, userState);
                }
                break;

            case 'select_appointment_type':
                if (message.startsWith('type_')) {
                    const typeId = message.replace('type_', '');
                    userState.context.selectedAppointmentType = typeId;
                    userState.context.bookingStep = 'select_time';
                    return await this.showAvailableTimes(phoneNumber, userState);
                }
                break;

            case 'select_time':
                if (message.startsWith('time_')) {
                    const timeSlot = message.replace('time_', '');
                    userState.context.selectedTime = timeSlot;
                    userState.context.bookingStep = 'confirm';
                    return await this.showBookingConfirmation(phoneNumber, userState);
                }
                break;

            case 'confirm':
                if (message.includes('confirm') || message.includes('yes')) {
                    return await this.confirmBooking(phoneNumber, userState);
                } else if (message.includes('cancel') || message.includes('no')) {
                    userState.step = 'main_menu';
                    return await this.whatsapp.sendMessage(phoneNumber, 
                        "Booking cancelled. How else can I help you?");
                }
                break;
        }

        return await this.whatsapp.sendMessage(phoneNumber, 
            "I didn't understand that. Please select from the available options.");
    }

    // Show appointment types
    async showAppointmentTypes(phoneNumber, userState) {
        try {
            const appointmentTypes = await this.cliniko.getAppointmentTypes({ per_page: 10 });
            
            const sections = [{
                title: 'Appointment Types',
                rows: appointmentTypes.appointment_types.map(type => ({
                    id: `type_${type.id}`,
                    title: type.name,
                    description: `${type.duration} minutes`
                }))
            }];

            return await this.whatsapp.sendList(
                phoneNumber,
                'What type of appointment would you like?',
                'Select Type',
                sections,
                { header: '📋 Appointment Types' }
            );
        } catch (error) {
            console.error('Error showing appointment types:', error);
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Sorry, I couldn't load appointment types. Please try again.");
        }
    }

    // Show available times
    async showAvailableTimes(phoneNumber, userState) {
        try {
            const { selectedPractitioner, selectedAppointmentType } = userState.context;
            
            const availableTimes = await this.cliniko.getNextAvailableSlots(
                selectedPractitioner, 
                selectedAppointmentType, 
                14, 
                10
            );

            if (!availableTimes.available_times || availableTimes.available_times.length === 0) {
                return await this.whatsapp.sendMessage(phoneNumber, 
                    "Sorry, no available appointments in the next 2 weeks. Please contact our reception for more options.");
            }

            const sections = [{
                title: 'Available Times',
                rows: availableTimes.available_times.slice(0, 10).map(slot => {
                    const date = new Date(slot.starts_at);
                    return {
                        id: `time_${slot.starts_at}`,
                        title: date.toLocaleDateString(),
                        description: date.toLocaleTimeString()
                    };
                })
            }];

            return await this.whatsapp.sendList(
                phoneNumber,
                'Please select your preferred appointment time:',
                'Select Time',
                sections,
                { header: '🕐 Available Times' }
            );
        } catch (error) {
            console.error('Error showing available times:', error);
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Sorry, I couldn't load available times. Please try again.");
        }
    }

    // Show booking confirmation
    async showBookingConfirmation(phoneNumber, userState) {
        const { selectedTime, selectedPractitioner, selectedAppointmentType } = userState.context;
        const practitioner = userState.context.practitioners.find(p => p.id == selectedPractitioner);
        
        const appointmentDate = new Date(selectedTime);
        
        const message = `📅 **Appointment Confirmation**

👤 Patient: ${userState.patient.first_name} ${userState.patient.last_name}
👨‍⚕️ Practitioner: ${practitioner?.name}
📅 Date: ${appointmentDate.toLocaleDateString()}
🕐 Time: ${appointmentDate.toLocaleTimeString()}

Please confirm your booking:`;

        const buttons = [
            { id: 'confirm', title: '✅ Confirm Booking' },
            { id: 'cancel', title: '❌ Cancel' }
        ];

        return await this.whatsapp.sendButtons(phoneNumber, message, buttons);
    }

    // Confirm booking
    async confirmBooking(phoneNumber, userState) {
        try {
            const { selectedTime, selectedPractitioner, selectedAppointmentType } = userState.context;
            
            const appointment = await this.cliniko.bookAppointment(
                userState.patient.id,
                selectedPractitioner,
                selectedAppointmentType,
                selectedTime,
                'Booked via WhatsApp Bot'
            );

            const practitioner = userState.context.practitioners.find(p => p.id == selectedPractitioner);
            
            await this.whatsapp.sendAppointmentConfirmation(
                phoneNumber,
                userState.patient.first_name,
                new Date(selectedTime).toLocaleString(),
                practitioner?.name || 'Doctor'
            );

            userState.step = 'main_menu';
            return { success: true, appointment };
        } catch (error) {
            console.error('Error confirming booking:', error);
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Sorry, I couldn't complete your booking. Please contact our reception team.");
        }
    }

    // Handle view appointments
    async handleViewAppointments(phoneNumber, userState) {
        try {
            const appointments = await this.cliniko.getUpcomingAppointments(userState.patient.id, 30);
            
            if (!appointments.appointments || appointments.appointments.length === 0) {
                userState.step = 'main_menu';
                return await this.whatsapp.sendMessage(phoneNumber, 
                    "You don't have any upcoming appointments. Would you like to book one?");
            }

            let message = `📅 **Your Upcoming Appointments:**\n\n`;
            
            appointments.appointments.forEach((apt, index) => {
                const formatted = this.cliniko.formatAppointmentForWhatsApp(apt);
                message += `${index + 1}. ${formatted.dateTime}\n`;
                message += `   👨‍⚕️ ${formatted.practitioner}\n`;
                message += `   📋 ${formatted.appointmentType}\n\n`;
            });

            userState.step = 'main_menu';
            return await this.whatsapp.sendMessage(phoneNumber, message);
        } catch (error) {
            console.error('Error viewing appointments:', error);
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Sorry, I couldn't load your appointments. Please try again.");
        }
    }

    // Start cancel appointment flow
    async startCancelFlow(phoneNumber, userState) {
        try {
            const appointments = await this.cliniko.getUpcomingAppointments(userState.patient.id, 30);
            
            if (!appointments.appointments || appointments.appointments.length === 0) {
                userState.step = 'main_menu';
                return await this.whatsapp.sendMessage(phoneNumber, 
                    "You don't have any upcoming appointments to cancel.");
            }

            const sections = [{
                title: 'Your Appointments',
                rows: appointments.appointments.map(apt => {
                    const formatted = this.cliniko.formatAppointmentForWhatsApp(apt);
                    return {
                        id: `cancel_${apt.id}`,
                        title: formatted.date,
                        description: `${formatted.time} - ${formatted.practitioner}`
                    };
                })
            }];

            userState.context.appointments = appointments.appointments;

            return await this.whatsapp.sendList(
                phoneNumber,
                'Which appointment would you like to cancel?',
                'Select Appointment',
                sections,
                { header: '❌ Cancel Appointment' }
            );
        } catch (error) {
            console.error('Error starting cancel flow:', error);
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Sorry, I couldn't load your appointments. Please try again.");
        }
    }

    // Handle cancel appointment
    async handleCancelAppointment(phoneNumber, message, userState) {
        if (message.startsWith('cancel_')) {
            const appointmentId = message.replace('cancel_', '');
            
            try {
                await this.cliniko.cancelAppointment(appointmentId, 'Cancelled via WhatsApp');
                
                userState.step = 'main_menu';
                return await this.whatsapp.sendMessage(phoneNumber, 
                    "✅ Your appointment has been cancelled successfully. We'll send you a confirmation shortly.");
            } catch (error) {
                console.error('Error cancelling appointment:', error);
                return await this.whatsapp.sendMessage(phoneNumber, 
                    "Sorry, I couldn't cancel your appointment. Please contact our reception team.");
            }
        }
    }

    // Handle patient registration
    async handlePatientRegistration(phoneNumber, message, userState) {
        if (message === '1') {
            userState.step = 'registration_details';
            userState.context.registrationStep = 'first_name';
            
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Great! Let's get you registered. First, what's your first name?");
        } else if (message === '2') {
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Please call our reception team at (555) 123-4567 during business hours: Mon-Fri 8AM-5PM.");
        } else {
            return await this.whatsapp.sendMessage(phoneNumber, 
                "Please reply with 1 to register or 2 to speak with reception.");
        }
    }

    // Clear user state (for testing)
    clearUserState(phoneNumber) {
        this.userStates.delete(phoneNumber);
    }

    // Get user state (for debugging)
    getUserState(phoneNumber) {
        return this.userStates.get(phoneNumber);
    }
}

module.exports = ConversationService;
