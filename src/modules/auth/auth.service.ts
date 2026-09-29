import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UserModel, UserDocument } from './user.model.js';
import { AuthResponse, CreateUserInput, IUser, UserRole } from './auth.types.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';

// No fallback on purpose: running with a hardcoded, source-visible secret
// would let anyone with read access to this code forge a valid login token
// for any account, including Super Admin. Fail loudly at startup instead.
if (!process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET environment variable is not set. Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
    'and add it to your .env file before starting the server.'
  );
}
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';

export class AuthService {
  private seeded = false;

  /**
   * Auto-seed ONLY the initial Super Admin account
   */
  public async ensureSeedUsers(): Promise<void> {
    if (this.seeded) return;
    try {
      // 1. Remove any legacy mock/demo users
      await UserModel.deleteMany({
        email: { $in: ['founder@colormyles.com', 'sudheer@colormyles.com'] }
      });

      // 2. Super Admin Account
      const superAdminEmail = 'gmsaisudheer@gmail.com';
      const existingSuperAdmin = await UserModel.findOne({
        email: { $in: [superAdminEmail, 'gmsaisudheer@gmail'] }
      });

      if (!existingSuperAdmin) {
        const passwordHash = await bcrypt.hash('gmsaisudheer@gmail', 10);
        await UserModel.create({
          email: superAdminEmail,
          passwordHash,
          name: 'Sai Sudheer (Super Admin)',
          role: 'SUPER_ADMIN',
          status: 'active',
        });
        console.log(`👑 Super Admin account initialized: ${superAdminEmail}`);
      }

      this.seeded = true;
    } catch (err) {
      console.warn('[AuthService] Error during user seed:', err);
    }
  }

  /**
   * Generate JWT Token
   */
  public generateToken(user: UserDocument): string {
    const payload = {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      empCode: user.empCode,
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Verify JWT Token
   */
  public verifyToken(token: string): any {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
  }

  /**
   * User Login (Supports Email OR Employee Code)
   */
  public async login(identifier: string, password: string): Promise<AuthResponse> {
    await this.ensureSeedUsers();

    const cleanIdentifier = identifier.trim().toLowerCase();
    
    // Find by email or empCode
    let user = await UserModel.findOne({
      $or: [
        { email: cleanIdentifier },
        { email: `${cleanIdentifier}@gmail.com` },
        { empCode: identifier.trim() }
      ]
    });

    // Super Admin shorthand check
    if (!user && (cleanIdentifier === 'gmsaisudheer@gmail' || cleanIdentifier === 'gmsaisudheer')) {
      user = await UserModel.findOne({ role: 'SUPER_ADMIN' });
    }

    if (!user) {
      throw new Error('Invalid email, employee ID or password.');
    }

    if (user.status !== 'active') {
      throw new Error('This account has been deactivated. Please contact Super Admin.');
    }

    // Verify Password
    const isMatch = await bcrypt.compare(password, user.passwordHash);

    if (!isMatch) {
      throw new Error('Invalid email, employee ID or password.');
    }

    const token = this.generateToken(user);

    return {
      token,
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
        empCode: user.empCode,
        status: user.status,
      },
    };
  }

  /**
   * Create Founder or Employee Account (Super Admin only)
   */
  public async createUser(input: CreateUserInput, requesterRole: UserRole): Promise<IUser> {
    if (requesterRole !== 'SUPER_ADMIN') {
      throw new Error('Access denied: Only Super Admin can create user accounts.');
    }

    const cleanEmail = input.email.trim().toLowerCase();
    const existing = await UserModel.findOne({ email: cleanEmail });
    if (existing) {
      throw new Error(`An account with email ${cleanEmail} already exists.`);
    }

    let finalName = input.name.trim();

    // If Employee, verify empCode and auto-fetch profile name
    if (input.role === 'EMPLOYEE') {
      if (!input.empCode) {
        throw new Error('Employee code is required for Employee accounts.');
      }
      const existingEmpCode = await UserModel.findOne({ empCode: input.empCode.trim() });
      if (existingEmpCode) {
        throw new Error(`An account is already linked to Employee Code #${input.empCode}.`);
      }
      const profile = await employeeMasterService.getProfile(input.empCode.trim());
      if (profile && !finalName) {
        finalName = profile.name;
      }
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    const newUser = await UserModel.create({
      email: cleanEmail,
      passwordHash,
      name: finalName || (input.role === 'FOUNDER' ? 'Founder' : `Employee ${input.empCode}`),
      role: input.role,
      empCode: input.empCode ? input.empCode.trim() : undefined,
      status: 'active',
    });

    return {
      _id: newUser._id.toString(),
      email: newUser.email,
      name: newUser.name,
      role: newUser.role,
      empCode: newUser.empCode,
      status: newUser.status,
      createdAt: newUser.createdAt,
    };
  }

  /**
   * List all user accounts (Super Admin only)
   */
  public async getAllUsers(requesterRole: UserRole): Promise<IUser[]> {
    if (requesterRole !== 'SUPER_ADMIN') {
      throw new Error('Access denied: Only Super Admin can view user accounts.');
    }
    await this.ensureSeedUsers();

    const users = await UserModel.find({}, '-passwordHash').sort({ createdAt: -1 });
    return users.map(u => ({
      _id: u._id.toString(),
      email: u.email,
      name: u.name,
      role: u.role,
      empCode: u.empCode,
      status: u.status,
      createdAt: u.createdAt,
    }));
  }

  /**
   * Delete user account (Super Admin only)
   */
  public async deleteUser(userId: string, requesterRole: UserRole): Promise<boolean> {
    if (requesterRole !== 'SUPER_ADMIN') {
      throw new Error('Access denied: Only Super Admin can delete users.');
    }
    const user = await UserModel.findById(userId);
    if (!user) throw new Error('User not found.');
    if (user.role === 'SUPER_ADMIN') {
      throw new Error('Cannot delete the root Super Admin account.');
    }
    await UserModel.findByIdAndDelete(userId);
    return true;
  }

  /**
   * Toggle user active status (Super Admin only)
   */
  public async toggleStatus(userId: string, requesterRole: UserRole): Promise<IUser> {
    if (requesterRole !== 'SUPER_ADMIN') {
      throw new Error('Access denied.');
    }
    const user = await UserModel.findById(userId);
    if (!user) throw new Error('User not found.');
    if (user.role === 'SUPER_ADMIN') throw new Error('Cannot modify Super Admin status.');

    user.status = user.status === 'active' ? 'inactive' : 'active';
    await user.save();

    return {
      _id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      empCode: user.empCode,
      status: user.status,
    };
  }

  /**
   * Reset user password (Super Admin only)
   */
  public async resetPassword(userId: string, newPass: string, requesterRole: UserRole): Promise<boolean> {
    if (requesterRole !== 'SUPER_ADMIN') {
      throw new Error('Access denied.');
    }
    const user = await UserModel.findById(userId);
    if (!user) throw new Error('User not found.');

    user.passwordHash = await bcrypt.hash(newPass, 10);
    await user.save();
    return true;
  }
}

export const authService = new AuthService();
