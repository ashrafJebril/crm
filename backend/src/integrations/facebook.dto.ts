import { IsNotEmpty, IsString, MinLength } from "class-validator";

export class ConnectFacebookDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(20, { message: "Token looks too short to be a Page Access Token" })
  accessToken!: string;
}

export class ReplyToCommentDto {
  @IsString()
  @IsNotEmpty()
  message!: string;
}
