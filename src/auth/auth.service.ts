import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { UserService } from "../user/user.service";
import { LoginUserDto } from "./dto/login-user.dto";
import { UserEntity } from "../user/entities/user.entity";
import * as bcrypt from "bcrypt";
import { Action } from "../shared/action";
import { expirationTime } from "./constants/constants";
import { OtpEntity } from "../otp/entities/otp.entity";
import * as process from "process";
import * as jwt from "jsonwebtoken";
import { MailService } from "../mail/mail.service";
import { SendOtpEmail } from "../mail/dto/send-otp-email";
import { Status } from "../shared/status";
import { TokenBlackListEntity } from "../token-black-list/entities/token-black-list.entity";
import { LessThan } from "typeorm";
import { OtpService } from "../otp/otp.service";
import { TokenBlackListService } from "../token-black-list/token-black-list.service";
import { SessionService } from "../session/session.service";

@Injectable()
export class AuthService {

  constructor(
    private usersService: UserService,
    private jwtService: JwtService,
    private mailService: MailService,
    private otpService: OtpService,
    private tokenBlackListService: TokenBlackListService,
    private readonly sessionService: SessionService
  ) {}


  async deleteInvalidedExpiredTokens () {
    try {
      const currentTime = new Date();
      await TokenBlackListEntity.delete({
        expires_at: LessThan(currentTime),
      });
    } catch (e) {
      throw new BadRequestException(e.message)
    }
  }
  async validateUser(loginUserDto: LoginUserDto) {
    try {
      const { username, password } = loginUserDto;
      const user = await UserEntity.findOne({
        where: [{ username: username }, { email: username }],
      });


      if (!user) {
        throw new HttpException('wrong username', HttpStatus.BAD_REQUEST);
      }

      const passwordMatches = await bcrypt.compare(password, user.password);

      if (!passwordMatches) {
        throw new HttpException('wrong password', HttpStatus.BAD_REQUEST);
      }

      if (user) {
        const { password, refresh_token, ...data } = user;
        console.log('validated');

        return data;
      }


    } catch (e) {
      throw new BadRequestException(e.message);
    }
  }

  async createAccessTokenFor2FA (user: any, action: Action, otp: string) {
    const accessTokenPayload = {
      id: user.id,
      username: user.username,
      roles: user.role,
      // here we use _2fa_required to indicate if the user need to verify 2FA otp
      _2fa_required: user.is_2_fa_active,
      _2fa: user.is_2_fa_active,
      status: user.status,
    };

    const accessToken = this.jwtService.sign(accessTokenPayload, {
      expiresIn: process.env.EXPIRES_IN_JWT,
      secret: process.env.SECRET_JWT
    });


    return {
      access_token_2fa: {
        action: action === Action.Login ? 'login with otp' : action,
        user_id: user.id,
        otp: otp,
        access_token: accessToken
      }
    }
  }

  createOtp() {
    const min = 100000;
    const max = 999999;
    const code = Math.floor(Math.random() * (max - min + 1)) + min;
    return code.toString();
  }

  async createAccessAndRefreshToken (user: any) {
    const accessTokenPayload = {
      id: user.id,
      _2fa: user.is_2_fa_active,
      username: user.username,
      roles: user.role,
      authenticate: true,
      status: user.status,
    };

    const accessToken = this.jwtService.sign(accessTokenPayload, {
      expiresIn: process.env.EXPIRES_IN_JWT,
      secret: process.env.SECRET_JWT
    });

    const refreshTokenPayload = {
      userId: user.id,
    };

    const refreshToken = this.jwtService.sign(refreshTokenPayload, {
      expiresIn: '7d',
      secret: process.env.SECRET_JWT
    });

    return {
      refresh_token: refreshToken,
      access_token: accessToken,
    }
  }

  async createAccessForRefreshToken (user: any) {
    const accessTokenPayload = {
      id: user.id,
      _2fa: user.is_2_fa_active,
      username: user.username,
      roles: user.role,
      authenticate: true,
      status: user.status,
    };

    const accessToken = this.jwtService.sign(accessTokenPayload, {
      expiresIn: process.env.EXPIRES_IN_JWT,
      secret: process.env.SECRET_JWT
    });

    return {
      access_token: accessToken
    }
  }

  // async login(loginUserDto: LoginUserDto) {
  //   try {
  //     console.log('?');
  //
  //     await this.deleteInvalidedExpiredTokens();
  //
  //     const { username } = loginUserDto;
  //
  //     console.log(username);
  //
  //     const user = await UserEntity.findOne({
  //       where: [{ username: username }, { email: username }],
  //     });
  //
  //     console.log(user);
  //
  //     user.refresh_token = null;
  //     await user.save();
  //
  //     const validateUser = await this.validateUser(loginUserDto);
  //     if (!validateUser) {
  //       console.log('user invalid');
  //       throw new UnauthorizedException();
  //     }
  //
  //     if (user.is_2_fa_active == true) {
  //       console.log('user has 2fa active');
  //       return await this.generateSendOtp(user.id, Action.Login)
  //     }
  //
  //     const tokens = await this.createAccessAndRefreshToken(user);
  //
  //     user.refresh_token = tokens.refresh_token;
  //     await user.save();
  //
  //     console.log('tokens');
  //     console.log(tokens);
  //
  //     return tokens;
  //   } catch (e) {
  //     throw new BadRequestException(e.message);
  //   }
  // }

    async loginWithSessions(loginUserDto: LoginUserDto, ip: string, userAgent: string) {
    try {
      await this.deleteInvalidedExpiredTokens();

      const { username } = loginUserDto;
      const user = await UserEntity.findOne({
        where: [{ username: username }, { email: username }],
      });

      const validateUser = await this.validateUser(loginUserDto);
      if (!validateUser) {
        throw new UnauthorizedException('Invalid username or password');
      }

      if (user.status === Status.Banned) {
        throw new UnauthorizedException('User is banned');
      }

      user.refresh_token = null;
      await user.save();

      if (user.is_2_fa_active == true) {
        return await this.generateSendOtp(user.id, Action.Login)
      }

      const tokens = await this.createAccessAndRefreshToken(user);

      user.refresh_token = tokens.refresh_token;
      user.status = Status.Active;
      await user.save();

      const sessionId = await this.sessionService.createSession(user.id, ip, userAgent);

      return {
        ...tokens,
        session_id: sessionId,
      };
    } catch (e) {
      throw new BadRequestException(e.message);
    }

  }


  async findBlacklistedToken(refreshToken: string) {
    try {
      const blacklistedToken = await TokenBlackListEntity.findOne({
        where: { token: refreshToken },
      });

      return blacklistedToken;
    } catch (e) {
      throw new BadRequestException(e.message);
    }
  }



  async generateSendOtp(id: string, action: Action) {
    try {
      const otp = this.createOtp();

      const date = new Date();
      const expiresDate = new Date(date.getTime() + expirationTime);

      const existingUser = await this.usersService.findOneReturnWithPass(id);

      console.log(id);

      if (!existingUser) {
        throw new BadRequestException({message: 'user does not exist or has not enabled 2fa auth'});
      }

      const existingOTPSForUser = await this.otpService.findAllForUser(id);

      await Promise.all(
        existingOTPSForUser.map(async (otp: OtpEntity) => {
          await otp.remove();
        }),
      );

     const savedOtp = await this.otpService.create(existingUser, action, expiresDate, otp);

      const otpBody: SendOtpEmail = {
        otp: otp,
        username: existingUser.username,
        email: existingUser.email
      }

      const sendOtp = await this.mailService.sendMail(otpBody);

      return await this.createAccessTokenFor2FA(existingUser, action, otp);

    } catch (e) {
      throw new BadRequestException(e.message);
    }
  }
  async isOtpExpired(id: string, _2fa: OtpEntity, action) {
    const timeNow = new Date(new Date().getTime());
    const isExpired = _2fa.expires_at < timeNow;


    if (isExpired) {
      await this.generateSendOtp(id, action);
      throw new UnauthorizedException();
    }
  }
  async verifyOtpLoginSession(id: string, otp: string, action: Action, accessTokenCookie: string, ip: string, userAgent: string) {
    try {

      const user = await UserEntity.findOne({
        where: { id: id },
      });

      if(user.status === Status.Banned) {
        throw new UnauthorizedException('User is banned');
      }

      const _2fa = await this.otpService.findOneByOtp(id, otp);

      if (!_2fa) {
        throw new UnauthorizedException('wrong otp');
      }

      await this.isOtpExpired(id, _2fa, action);

      if (!accessTokenCookie) {
        throw new UnauthorizedException('access_token from login user with username and password missing');
      }

      const decoded: any = jwt.decode(accessTokenCookie);
      if (!decoded ||  decoded._2fa !== true) {
        throw new UnauthorizedException('Invalid token for verifying otp - login');
      }

      const token = await this.createAccessAndRefreshToken(user);

      user.refresh_token = token.refresh_token;
      user.status = Status.Active;
      await user.save();

      const sessionId = await this.sessionService.createSession(user.id, ip, userAgent);


      return {
        ...token,
        session_id: sessionId,
      };
    } catch (e) {
      throw new BadRequestException(e.message);
    }
  }

  async verifyOtpLogin(id: string, otp: string, action: Action, accessTokenCookie: string) {
    try {

      const user = await UserEntity.findOne({
        where: { id: id },
      });

      const _2fa = await this.otpService.findOneByOtp(id, otp);

      if (!_2fa) {
        throw new UnauthorizedException('wrong otp');
      }

      await this.isOtpExpired(id, _2fa, action);

      if (!accessTokenCookie) {
        throw new UnauthorizedException('access_token from login user with username and password missing');
      }

      const decoded: any = jwt.decode(accessTokenCookie);
      if (!decoded ||  decoded._2fa !== true) {
        throw new UnauthorizedException('Invalid token for verifying otp - login');
      }

      const token = await this.createAccessAndRefreshToken(user);

      user.refresh_token = token.refresh_token;
      await user.save();

      return token;
    } catch (e) {
      throw new BadRequestException(e.message);
    }
  }
  async refreshToken(refreshToken: any) {
    try {

      if (!refreshToken) {
        throw new UnauthorizedException('Refresh token missing');
      }

      const decoded: any = jwt.verify(refreshToken, process.env.SECRET_JWT);

      if (!decoded || !decoded.userId) {
        throw new Error('Invalid refresh token');
      }

      const user = await this.usersService.findOneReturnWithPass(decoded.userId.toString());

      if (!user || user.refresh_token !== refreshToken) {
        throw new UnauthorizedException('Invalid refresh token');
        // throw new Error('User not found');
      }

      return await this.createAccessForRefreshToken(user);
    } catch (e) {
      throw new BadRequestException(e.message);
    }
  }

  async logout(accessToken, refreshToken) {
    try {
      await this.deleteInvalidedExpiredTokens();


      if (!accessToken || !refreshToken) {
       throw new BadRequestException('No token provided');
      }

      const decodedAccessToken: any = jwt.verify(accessToken, process.env.SECRET_JWT);

      const user = await UserEntity.findOneBy({id: decodedAccessToken.user_id})
      if (!user) {
        throw new UnauthorizedException();
      }

      await this.tokenBlackListService.create(accessToken, decodedAccessToken, user);

      const decodedRefreshToken: any = jwt.verify(refreshToken, process.env.SECRET_JWT);
      await this.tokenBlackListService.create(refreshToken, decodedRefreshToken, user);


      const userOtps = await this.otpService.findAllForUser(user.id);
      if (userOtps) {
        await Promise.all(
          userOtps.map(async (row: OtpEntity) => {
            await row.remove();
          }),
        );
      }

      user.refresh_token = null;
      if (user.status !== Status.Banned) {
        user.status = Status.Inactive;
      }
      await user.save();
      return {
        message: 'user.logout',
      };
    } catch (e) {
      throw new BadRequestException(e.message);
    }
  }

  async checkIfLogIn() {

  }

}
